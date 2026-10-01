import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire, findPackageJSON } from 'node:module';
import { dirname, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { piAiRouteInfo, piAiPricing, createPiAiTransport, openRouterRoutingCaps, MAX_INPUT_BYTES, KEEPALIVE } from '../lib/pi-ai.js';

const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'));
const requireNative = createRequire(manifest);
const native = name => requireNative(resolve(dirname(manifest), `dist/${name}.js`));
const usage = (overrides = {}) => ({ input: 30, output: 1, cacheRead: 2000, cacheWrite: 0, totalTokens: 2031,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...overrides });
const message = (model, overrides = {}) => ({ role: 'assistant', content: [{ type: 'text', text: 'OK' }],
  api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason: 'stop', timestamp: 0, ...overrides });
function fixture({ api = 'openai-completions', provider = 'fixture', descriptor = {}, run,
  resolveApiKey = async () => 'offline-secret', auth, providerAuth } = {}) {
  const model = { id: 'fixture-model', type: 'chat', provider, api, baseUrl: 'http://127.0.0.1:1/v1',
    input: ['text'], reasoning: false, maxTokens: 4096, contextWindow: 100000,
    cost: { input: 1, output: 2, cacheRead: .1, cacheWrite: 1 }, ...descriptor };
  const observed = [];
  const piProvider = { id: provider, name: 'Offline test', getModels: () => [model],
    auth: providerAuth ?? { apiKey: { resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'test' }) } },
    streamSimple(selected, context, options) {
      observed.push({ selected, context, options });
      if (run) return run(selected, context, options);
      return (async function* () {
        await options.onPayload({ model: selected.id, stream: true, max_completion_tokens: options.maxTokens,
          messages: [{ role: 'user', content: 'captured' }] }, selected);
        yield { type: 'done', reason: 'stop', message: message(selected) };
      })();
    } };
  const profile = { provider, displayName: 'Offline test', piProvider, cacheRetention: 'long',
    configuredMaxTokens: new Map(), modelErrors: new Map(), streamIdleTimeoutMs: 1000,
    headers: { 'X-Secret': 'private-header' }, thinkingBudgets: { high: 10000 } };
  let profiles = new Map([[provider, profile]]);
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth });
  const ctx = { llm: { adapters: new Map([[provider, { adapter }]]) } };
  return { ctx, provider, model, profile, adapter, observed, replaceProfiles(value) { profiles = value; },
    options: { provider, model: model.id, sessionId: 'durable-session', system: 'captured system', temperature: .2,
      toolHistory: { captured: 'opaque-history' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'captured prefix' }] }],
      tools: [{ name: 'lookup', description: 'History only', parameters: { type: 'object', properties: {} } }], maxTokens: 8 } };
}
const collect = async (f, options = f.options) => Array.fromAsync((await createPiAiTransport(f.ctx, { provider: f.provider, model: f.model.id, options })).stream(options));

test('synchronous ownership checks actual registered class; reports no credentials', () => {
  const ctx = { llm: { adapters: new Map([['openai', { adapter: { current() {} } }]]) } };
  assert.equal(piAiRouteInfo(ctx, 'openai', 'anything').owned, false);
  const f = fixture();
  const info = piAiRouteInfo(f.ctx, f.provider, f.model.id);
  assert.equal(info.owned, true); assert.equal(info.supported, true); assert.equal(info.retention, 'long');
  assert.equal(info.maxOutputTokens, 256); assert.equal(info.outputReserve, 256); assert.equal(info.outputBound, 'server');
  assert.equal(info.fingerprint, piAiRouteInfo(f.ctx, f.provider, f.model.id).fingerprint);
  assert.equal(JSON.stringify(info).includes('private-header'), false);
  assert.equal(JSON.stringify(info).includes('offline-secret'), false);
});

test('unsupported nonchat/missing capabilities/fallbacks/Bedrock retries fail explicitly', () => {
  for (const [descriptor, reasonCode] of [[{ type: 'image' }, 'unsupported-model'], [{ input: ['image'] }, 'unsupported-model'],
    [{ api: 'unknown-native' }, 'unsupported-protocol'], [{ api: 'bedrock-converse-stream' }, 'unsupported-no-retry'],
    [{ compat: { allowedFallbackModels: [{ model: 'different' }] } }, 'unsupported-fallbacks']]) {
    const f = fixture({ descriptor }), info = piAiRouteInfo(f.ctx, f.provider, f.model.id);
    assert.equal(info.owned, true); assert.equal(info.supported, false); assert.equal(info.reasonCode, reasonCode);
  }
  const f = fixture({ descriptor: { type: undefined } });
  assert.equal(piAiRouteInfo(f.ctx, f.provider, f.model.id).supported, true);
});

test('recognized configured text-chat protocols admitted; Codex/Responses honest client bound', () => {
  for (const api of ['openai-completions', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses',
    'anthropic-messages', 'google-generative-ai', 'google-vertex', 'mistral-conversations', 'pi-messages']) {
    const f = fixture({ api }), info = piAiRouteInfo(f.ctx, f.provider, f.model.id);
    assert.equal(info.supported, true, api);
    assert.equal(info.outputBound, ['openai-codex-responses', 'openai-responses'].includes(api) ? 'client' : 'server');
  }
});

test('pricing is exact owner cost function with bundled provenance; unknown synthetic zero cost stays unknown', () => {
  const { getBuiltinModels } = native('providers/all'), { calculateCost } = native('models');
  const bundled = getBuiltinModels('openai').find(value => value.input.includes('text') && value.type !== 'image');
  const f = fixture({ provider: 'openai', descriptor: bundled }), pricing = piAiPricing(f.ctx, 'openai', bundled.id);
  assert.ok(pricing); assert.equal(pricing.calculateCost, calculateCost); assert.deepEqual(pricing.model.cost, bundled.cost);
  assert.equal(pricing.fingerprint, piAiRouteInfo(f.ctx, 'openai', bundled.id).fingerprint);
  assert.equal(pricing.model.headers, undefined); assert.equal(pricing.model.baseUrl, undefined);
  assert.equal(calculateCost(pricing.model, usage()).total, calculateCost(bundled, usage()).total);
  const unknown = fixture({ descriptor: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  assert.equal(piAiPricing(unknown.ctx, unknown.provider, unknown.model.id), null);
});

test('isolated adapter preserves prefix, schemas, native replay, session, temperature and credential authority', async () => {
  let received;
  const f = fixture({ resolveApiKey: async (provider, profile) => { received = { provider, profile }; return 'offline-secret'; } });
  f.profile.reasoning = 'high';
  f.options.reasoningEffort = 'off';
  f.options.messages.push({ role: 'assistant', source: { provider: f.provider, model: f.model.id,
    replayState: { response: { kind: 'pi-ai', version: 2, api: f.model.api, provider: f.provider, model: f.model.id,
      responseId: 'native-response', stopReason: 'stop' }, blocks: [{ type: 'text', textSignature: 'native-signature' }] } },
    content: [{ type: 'text', text: 'captured assistant' }] });
  const before = structuredClone(f.options), nativeBefore = structuredClone(f.model), chunks = await collect(f);
  assert.equal(chunks.at(-1).reason.kind, 'stop'); assert.equal(chunks.find(c => c.type === 'usage').usage.cacheReadTokens, 2000);
  assert.equal(received.profile, f.profile); assert.equal(received.provider, f.provider);
  const { context, options, selected } = f.observed[0];
  assert.equal(context.messages.find(m => m.role === 'user').content, 'captured prefix');
  assert.equal(context.messages.at(-1).content, KEEPALIVE);
  const assistant = context.messages.find(m => m.role === 'assistant');
  assert.equal(assistant.responseId, 'native-response'); assert.equal(assistant.content[0].textSignature, 'native-signature');
  assert.equal(options.sessionId, 'durable-session'); assert.equal(options.apiKey, 'offline-secret');
  assert.equal(options.maxRetries, 0); assert.equal(options.maxTokens, 256); assert.equal(options.toolChoice, undefined);
  assert.equal(options.temperature, .2); assert.notEqual(selected, f.model);
  assert.deepEqual(f.model, nativeBefore); assert.deepEqual(f.options, before);
  assert.equal(f.profile.reasoning, 'high'); assert.equal(f.profile.thinkingBudgets.high, 10000);
  assert.ok(context.messages.some(m => m.toolsAdded?.[0]?.name === 'lookup'));
});

test('route changes before/after harness auth and native auth refuse sends', async () => {
  let sends = 0;
  const f = fixture({ resolveApiKey: async () => { f.profile.headers.changed = 'private'; return 'offline-secret'; }, run: () => { sends++; return []; } });
  await assert.rejects(collect(f), error => error.reasonCode === 'route-changed'); assert.equal(sends, 0);
  const g = fixture(), transport = await createPiAiTransport(g.ctx, { provider: g.provider, model: g.model.id });
  g.replaceProfiles(new Map([[g.provider, { ...g.profile }]]));
  await assert.rejects(Array.fromAsync(transport.stream(g.options)), error => error.reasonCode === 'route-changed');
  const h = fixture({ resolveApiKey: async () => undefined, providerAuth: { apiKey: { resolve: async () => {
    h.profile.cacheRetention = 'short'; return { auth: { apiKey: 'offline-secret' }, source: 'test' };
  } } }, run: () => { sends++; return []; } });
  const chunks = await collect(h); assert.equal(sends, 0); assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.some(c => c.type === 'usage'), false);
});

test('native OAuth refresh/store authority and authorized endpoint rewrite preserved', async () => {
  let credential = { type: 'oauth', access: 'old-secret', expires: 0 }, reads = 0, modifications = 0, refreshes = 0;
  const f = fixture({ resolveApiKey: async () => undefined, auth: { credentials: {
    async read() { reads++; return credential; }, async modify(_id, mutate) { modifications++; credential = await mutate(credential); return credential; },
    async list() { return []; }, async delete() {},
  }, authContext: { env: async () => undefined, fileExists: async () => false } }, providerAuth: { oauth: {
    async refresh(stored, signal) { refreshes++; assert.equal(signal.aborted, false); return { ...stored, access: 'rotated-secret', expires: Date.now() + 86400000 }; },
    async toAuth(stored) { return { apiKey: stored.access, baseUrl: 'http://127.0.0.1:1/authorized-endpoint' }; },
  } } });
  assert.equal((await collect(f)).at(-1).reason.kind, 'stop');
  assert.equal(reads, 1); assert.equal(modifications, 1); assert.equal(refreshes, 1);
  assert.equal(f.observed[0].selected.baseUrl, 'http://127.0.0.1:1/authorized-endpoint');
  assert.equal(f.observed[0].options.apiKey, 'rotated-secret'); assert.equal(f.model.baseUrl, 'http://127.0.0.1:1/v1');
  assert.equal(JSON.stringify(piAiRouteInfo(f.ctx, f.provider, f.model.id)).includes('rotated-secret'), false);
});

test('attachments/deferred tools/oversized text/mismatched routes rejected before credential resolution', async () => {
  let authCalls = 0;
  const f = fixture({ resolveApiKey: async () => { authCalls++; return 'offline-secret'; } });
  for (const options of [{ ...f.options, messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] },
    { ...f.options, tools: [{ ...f.options.tools[0], deferLoading: true }] }, { ...f.options, system: 'x'.repeat(MAX_INPUT_BYTES + 1) },
    { ...f.options, provider: 'different' }]) await assert.rejects(collect(f, options));
  assert.equal(authCalls, 0);
});

test('final payload guard rejects cap overshoot/billed tools/image injection/extra operations', async () => {
  for (const body of [{ max_completion_tokens: 4096 }, { tools: [{ type: 'web_search' }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'secret' } }] }] }, { modalities: ['image'] }, { n: 2 }]) {
    let sends = 0;
    const f = fixture({ run: (selected, _context, options) => (async function* () {
      await options.onPayload({ model: selected.id, stream: true, max_completion_tokens: 256,
        messages: [{ role: 'user', content: 'captured' }], ...body }, selected);
      sends++; yield { type: 'done', reason: 'stop', message: message(selected) };
    })() });
    const chunks = await collect(f); assert.equal(sends, 0); assert.equal(chunks.at(-1).reason.kind, 'error');
    assert.equal(chunks.some(c => c.type === 'usage'), false);
  }
});

test('client char/thinking/tool bound aborts output; zero abort usage and SDK secrets never escape', async () => {
  for (const event of [{ type: 'text_delta', delta: 'x'.repeat(1025), contentIndex: 0 },
    { type: 'thinking_delta', delta: 'x'.repeat(1025), contentIndex: 0 },
    { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ type: 'toolCall', id: 'id', name: 'lookup' }] } }]) {
    let signal;
    const f = fixture({ run: (_selected, _context, options) => (async function* () { signal = options.signal; yield event; })() });
    const chunks = await collect(f); assert.equal(chunks.at(-1).reason.kind, 'aborted'); assert.equal(signal.aborted, true);
    assert.equal(chunks.some(c => c.type === 'usage'), false);
  }
  const f = fixture({ run: selected => (async function* () {
    yield { type: 'error', reason: 'aborted', error: message(selected, { stopReason: 'aborted',
      errorMessage: 'Bearer offline-secret private-header', usage: usage({ input: 0, output: 0, cacheRead: 0, totalTokens: 0 }) }) };
  })() });
  const chunks = await collect(f); assert.equal(chunks.some(c => c.type === 'usage'), false);
  assert.equal(JSON.stringify(chunks).includes('offline-secret'), false);
});

test('caller abort while credential authority stalls completes immediately without late sends', async () => {
  let resolveKey, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const f = fixture({ resolveApiKey: () => { markStarted(); return new Promise(resolve => { resolveKey = resolve; }); } });
  const controller = new AbortController(), request = collect(f, { ...f.options, signal: controller.signal });
  await started; controller.abort('private abort reason');
  assert.equal((await request).at(-1).reason.kind, 'aborted'); resolveKey('late-secret');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.observed.length, 0);
});

async function loopback(t, handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function bodyOf(request) {
  const pieces = []; for await (const piece of request) pieces.push(piece);
  const body = Buffer.concat(pieces);
  return JSON.parse((request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(body) : body).toString('utf8'));
}
const protocols = ['openai-completions', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses',
  'anthropic-messages', 'mistral-conversations', 'google-generative-ai', 'google-vertex', 'pi-messages'];
for (const api of protocols) {
  test(`actual ${api} native serializer loopback: one retryable-error request, prefix/tools/cap/error hygiene`, async t => {
    let observed, url, count = 0;
    const base = await loopback(t, async (request, response) => {
      count++; url = request.url; observed = await bodyOf(request); response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'offline-secret provider error', type: 'invalid_request_error' } }));
    });
    const serializer = native(`api/${api}`);
    const token = `offline.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-account' } })).toString('base64')}.signature`;
    const f = fixture({ api, descriptor: { baseUrl: `${base}/v1` }, resolveApiKey: async () => api === 'openai-codex-responses' ? token : 'offline-secret',
      providerAuth: { apiKey: { resolve: async ({ credential }) => ({ auth: { apiKey: credential.key }, source: 'test',
        env: { AZURE_OPENAI_BASE_URL: `${base}/v1`, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'fixture-model=offline-deployment' } }) } },
      run: (model, context, options) => serializer.streamSimple(model, context, options) });
    const chunks = await collect(f);
    assert.equal(count, 1, JSON.stringify(chunks));
    if (api.startsWith('google-')) assert.ok(url.includes(f.model.id));
    else assert.equal(observed.model, api === 'azure-openai-responses' ? 'offline-deployment' : f.model.id);
    assert.ok(JSON.stringify(observed).includes('captured prefix')); assert.ok(JSON.stringify(observed).includes(KEEPALIVE));
    assert.ok(JSON.stringify(observed).includes('lookup'));
    if (api === 'openai-codex-responses') {
      assert.equal(observed.max_output_tokens, undefined); assert.equal(f.observed[0].options.transport, 'sse');
      assert.equal(observed.tool_choice, 'auto');
    } else if (api.startsWith('google-')) {
      assert.equal(observed.generationConfig.maxOutputTokens, 256);
      assert.notEqual(observed.toolConfig?.functionCallingConfig?.mode, 'NONE');
    } else if (api === 'pi-messages') {
      assert.equal(observed.options.maxTokens, 256); assert.equal(observed.options.toolChoice, undefined);
    } else {
      assert.equal(observed.max_completion_tokens ?? observed.max_tokens ?? observed.max_output_tokens, 256);
      assert.equal(observed.tool_choice, undefined);
      assert.equal(observed.tools.length, 1);
    }
    assert.equal(chunks.at(-1).reason.kind, 'error'); assert.equal(chunks.some(c => c.type === 'usage'), false);
    assert.equal(JSON.stringify(chunks).includes('offline-secret'), false);
  });
}

test('pricing refuses custom billing endpoints/protocols/routing and conservatively identifies long cache writes', () => {
  const { getBuiltinModels } = native('providers/all');
  const bundled = getBuiltinModels('openai').find(value => value.input.includes('text'));
  for (const patch of [{ baseUrl: 'https://unreviewed.invalid/v1' }, { api: 'anthropic-messages' },
    { compat: { ...bundled.compat, openRouterRouting: { order: ['unknown'] } } }]) {
    const f = fixture({ provider: 'openai', descriptor: { ...bundled, ...patch } });
    assert.equal(piAiPricing(f.ctx, f.provider, f.model.id), null);
  }
  const anthropic = getBuiltinModels('anthropic').find(value => value.input.includes('text') && !value.compat?.allowedFallbackModels?.length);
  const f = fixture({ provider: 'anthropic', descriptor: anthropic });
  assert.equal(piAiPricing(f.ctx, f.provider, f.model.id).cacheWrite1h, true);
  f.profile.cacheRetention = 'short';
  assert.equal(piAiPricing(f.ctx, f.provider, f.model.id).cacheWrite1h, false);
  delete f.profile.cacheRetention;
  assert.equal(piAiPricing(f.ctx, f.provider, f.model.id).cacheWrite1h, true);
});

test('genuine supported low adaptive thinking is preserved when off/minimal are not declared', async t => {
  let payload;
  const base = await loopback(t, async (request, response) => {
    payload = await bodyOf(request); response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}');
  });
  const serializer = native('api/anthropic-messages');
  const f = fixture({ api: 'anthropic-messages', descriptor: { baseUrl: base, reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low' }, compat: { forceAdaptiveThinking: true } },
    run: (model, context, options) => serializer.streamSimple(model, context, options) });
  f.profile.reasoning = 'high'; f.options.reasoningEffort = 'low';
  assert.equal(piAiRouteInfo(f.ctx, f.provider, f.model.id, f.options).supported, true);
  await collect(f);
  assert.equal(payload.thinking.type, 'adaptive'); assert.equal(payload.output_config.effort, 'low');
  assert.equal(payload.max_tokens, 256); assert.equal(payload.tool_choice, undefined);
  assert.equal(f.profile.reasoning, 'high');
});

test('real stalled native request aborts within 10-second total deadline, without synthetic priced usage', async t => {
  let requests = 0;
  const base = await loopback(t, async request => { requests++; await bodyOf(request); });
  const serializer = native('api/openai-completions');
  const f = fixture({ descriptor: { baseUrl: base }, run: (model, context, options) => serializer.streamSimple(model, context, options) });
  const started = Date.now();
  const chunks = await collect(f);
  assert.equal(requests, 1); assert.equal(chunks.at(-1).reason.kind, 'aborted');
  assert.equal(chunks.some(c => c.type === 'usage'), false);
  assert.ok(Date.now() - started >= 9000); assert.ok(Date.now() - started < 12000);
});

test('OpenRouter routing ceilings include all reviewed tiers, cache rates and one-hour writes', () => {
  const cost = { input: 2, output: 3, cacheRead: .1, cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 200000, input: 4, output: 5, cacheRead: .2, cacheWrite: 5 }] };
  assert.deepEqual(openRouterRoutingCaps(cost), { require_parameters: true, allow_fallbacks: false,
    max_price: { prompt: 5, completion: 5, request: 0 } });
  assert.deepEqual(openRouterRoutingCaps(cost, true), { require_parameters: true, allow_fallbacks: false,
    max_price: { prompt: 8, completion: 5, request: 0 } });
  for (const malformed of [{ ...cost, output: Infinity }, { ...cost, tiers: {} },
    { ...cost, tiers: [{ ...cost.tiers[0], inputTokensAbove: NaN }] }, { ...cost, cacheRead: -1 },
    { ...cost, extraFee: 1 }, { ...cost, input: Number.MAX_VALUE }]) {
    assert.equal(openRouterRoutingCaps(malformed, true), null);
  }
});

function routerModel() {
  return native('providers/all').getBuiltinModels('openrouter').find(value => value.api === 'openai-completions'
    && value.id.startsWith('~deepseek/') && value.cost.input > 0);
}

test('OpenRouter dynamic aliases and unsupported serializers fail before credentials, including renamed endpoint routes', async () => {
  let authCalls = 0;
  const resolveApiKey = async () => { authCalls++; return 'offline-secret'; };
  for (const provider of ['openrouter', 'renamed-router']) {
    for (const id of ['auto', 'free', 'fusion', 'openrouter/auto', 'openrouter/auto-beta', 'openrouter/free', 'openrouter/fusion', 'openai/gpt-4.1:online']) {
      const f = fixture({ provider, resolveApiKey, descriptor: { ...routerModel(), provider, id,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
      assert.equal(piAiRouteInfo(f.ctx, provider, id).reasonCode, 'unsupported-model');
      assert.equal(piAiPricing(f.ctx, provider, id), null);
      await assert.rejects(collect(f), error => error.reasonCode === 'unsupported-model');
    }
    for (const api of protocols.filter(value => value !== 'openai-completions')) {
      const f = fixture({ provider, resolveApiKey, descriptor: { ...routerModel(), provider, api } });
      assert.equal(piAiRouteInfo(f.ctx, provider, f.model.id).reasonCode, 'unsupported-protocol');
      await assert.rejects(collect(f), error => error.reasonCode === 'unsupported-protocol');
    }
  }
  const unknown = fixture({ provider: 'openrouter', resolveApiKey });
  assert.equal(piAiRouteInfo(unknown.ctx, unknown.provider, unknown.model.id).reasonCode, 'unknown-pricing');
  await assert.rejects(collect(unknown), error => error.reasonCode === 'unknown-pricing');
  assert.equal(authCalls, 0);
});

test('concrete reviewed free OpenRouter model is not confused with a dynamic free router', () => {
  const free = native('providers/all').getBuiltinModels('openrouter').find(value => value.api === 'openai-completions'
    && value.id.endsWith(':free') && value.cost.input === 0 && value.cost.output === 0);
  assert.ok(free);
  const f = fixture({ provider: 'openrouter', descriptor: free });
  assert.equal(piAiRouteInfo(f.ctx, f.provider, f.model.id).supported, true);
  assert.ok(piAiPricing(f.ctx, f.provider, f.model.id));
});

test('actual OpenRouter Completions serializer sends immutable catalog-derived routing guards, prefix, tools and native reasoning', async t => {
  let payload, requests = 0;
  const base = await loopback(t, async (request, response) => {
    requests++; payload = await bodyOf(request); response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}');
  });
  const bundled = routerModel(), serializer = native('api/openai-completions');
  const f = fixture({ provider: 'openrouter', descriptor: { ...bundled, baseUrl: `${base}/v1` },
    run: (model, context, options) => serializer.streamSimple(model, context, options) });
  f.options.reasoningEffort = 'high';
  const before = structuredClone(f.model), optionsBefore = structuredClone(f.options);
  const chunks = await collect(f);
  assert.equal(requests, 1, JSON.stringify(chunks));
  assert.deepEqual(payload.provider, openRouterRoutingCaps(bundled.cost));
  assert.equal(payload.model, bundled.id);
  assert.equal(payload.max_completion_tokens ?? payload.max_tokens, 256);
  assert.equal(payload.reasoning.effort, 'high');
  assert.ok(JSON.stringify(payload.messages).includes('captured prefix'));
  assert.ok(JSON.stringify(payload.messages).includes(KEEPALIVE));
  assert.equal(payload.tools[0].function.name, 'lookup');
  assert.deepEqual(f.model, before); assert.deepEqual(f.options, optionsBefore);
});

test('renamed OpenRouter endpoint preserves routing protection through authorized auth endpoint rewrite', async t => {
  let payload, requests = 0;
  const base = await loopback(t, async (request, response) => {
    requests++; payload = await bodyOf(request); response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}');
  });
  const provider = 'renamed-router', bundled = routerModel(), serializer = native('api/openai-completions');
  const f = fixture({ provider, descriptor: { ...bundled, provider }, resolveApiKey: async () => undefined,
    providerAuth: { apiKey: { resolve: async () => ({ auth: { apiKey: 'offline-secret', baseUrl: `${base}/v1` }, source: 'test' }) } },
    run: (model, context, options) => serializer.streamSimple(model, context, options) });
  const before = structuredClone(f.model);
  assert.equal(piAiRouteInfo(f.ctx, provider, f.model.id).supported, true);
  await collect(f);
  assert.equal(requests, 1);
  assert.deepEqual(payload.provider, openRouterRoutingCaps(bundled.cost));
  assert.deepEqual(f.model, before);
});

test('actual OpenRouter cache-control serializer reserves native one-hour cache-write prices', async t => {
  let payload;
  const base = await loopback(t, async (request, response) => {
    payload = await bodyOf(request); response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}');
  });
  const bundled = native('providers/all').getBuiltinModels('openrouter').find(value => value.api === 'openai-completions'
    && value.compat?.cacheControlFormat === 'anthropic' && !value.compat?.allowedFallbackModels?.length);
  assert.ok(bundled);
  const serializer = native('api/openai-completions');
  const f = fixture({ provider: 'openrouter', descriptor: { ...bundled, baseUrl: `${base}/v1` },
    run: (model, context, options) => serializer.streamSimple(model, context, options) });
  await collect(f);
  assert.deepEqual(payload.provider, openRouterRoutingCaps(bundled.cost, true));
  assert.ok(JSON.stringify(payload).includes('1h'));
});

test('native OpenRouter guard rejects missing/weakened routing after real serialization before the loopback request', async t => {
  let requests = 0;
  const base = await loopback(t, (_request, response) => { requests++; response.writeHead(500); response.end('{}'); });
  const serializer = native('api/openai-completions');
  const mutate = [body => { delete body.provider; }, body => { body.provider.require_parameters = false; },
    body => { body.provider.allow_fallbacks = true; }, body => { body.provider.max_price.request = .01; },
    body => { body.provider.max_price.prompt += 1; }, body => { body.provider.max_price.completion += 1; },
    body => { body.provider.extra_billed_operation = true; }];
  for (const patch of mutate) {
    const f = fixture({ provider: 'openrouter', descriptor: { ...routerModel(), baseUrl: `${base}/v1` },
      run: (model, context, options) => serializer.streamSimple(model, context, { ...options,
        onPayload(payload, selected) { patch(payload); return options.onPayload(payload, selected); } }) });
    const chunks = await collect(f);
    assert.equal(chunks.at(-1).reason.kind, 'error');
    assert.equal(chunks.some(chunk => chunk.type === 'usage'), false);
  }
  assert.equal(requests, 0);
});

test('auth endpoint rewrite cannot turn a foreign route into an unguarded OpenRouter send', async () => {
  let sends = 0;
  const f = fixture({ resolveApiKey: async () => undefined,
    providerAuth: { apiKey: { resolve: async () => ({ auth: { apiKey: 'offline-secret', baseUrl: 'https://openrouter.ai/api/v1' }, source: 'test' }) } },
    run: () => { sends++; return []; } });
  const chunks = await collect(f);
  assert.equal(sends, 0); assert.equal(chunks.at(-1).reason.kind, 'error');
});

test('actual Anthropic mandatory thinking expansion fails payload guard before any request', async t => {
  let requests = 0;
  const base = await loopback(t, (_request, response) => { requests++; response.writeHead(500); response.end(); });
  const serializer = native('api/anthropic-messages');
  const f = fixture({ api: 'anthropic-messages', descriptor: { baseUrl: base, reasoning: true,
    thinkingLevelMap: { off: null, minimal: 'minimal' } },
    run: (model, context, options) => serializer.streamSimple(model, context, options) });
  f.options.reasoningEffort = 'minimal';
  assert.equal(piAiRouteInfo(f.ctx, f.provider, f.model.id, f.options).reasonCode, 'unsafe-thinking-budget');
  await assert.rejects(collect(f), error => error.reasonCode === 'unsafe-thinking-budget');
  assert.equal(requests, 0);
});
