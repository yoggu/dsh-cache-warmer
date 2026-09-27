import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { zstdDecompressSync } from 'node:zlib';
import { LlmRuntime, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { CODEX_WARM_OUTPUT_RESERVATION, CODEX_WARM_PROMPT, createCodexTransport, readCodexRoute } from '../lib/codex.js';

// The inspected installed dsh-codex-account resolves to this sibling checkout.
// Its exact adapter, converter, account scoping and pinned pi-ai copy are tested;
// production uses only public ctx.llm APIs and never imports these internals.
const accountRoot = new URL('../../dsh-codex-account/', import.meta.url);
const accountRequire = createRequire(new URL('package.json', accountRoot));
const { Context } = await import(accountRequire.resolve('@deepseek-ai/cordis'));
const { CodexAccountAdapter } = await import(new URL('lib/adapter.js', accountRoot));
const { accountScopedStore } = await import(new URL('lib/store.js', accountRoot));
const piRoot = new URL('node_modules/@earendil-works/pi-ai/dist/', accountRoot);
const { createModels } = await import(new URL('models.js', piRoot));
const { openaiCodexProvider } = await import(new URL('providers/openai-codex.js', piRoot));

const PROVIDER = 'codex-personal';
const MODEL = 'gpt-6-astra';
const SESSION = 'offline-codex-session';
const config = () => ({
  accounts: [{ id: 'personal', provider: PROVIDER }, { id: 'business', provider: 'codex-business' }],
  transport: 'sse', cacheRetention: 'long', models: [], defaultEfforts: {},
});
function routeFixture(llm) {
  const owner = { options: { id: 'codex-account', name: 'dsh-codex-account' }, fiber: { state: 2, uid: 1, config: config() } };
  const services = {
    llm,
    configEditor: { entries: () => [owner] },
    // Like the real settings service, NONVOLATILE Codex fields are absent.
    settings: { describe() { return []; } },
  };
  return { ctx: { get: key => services[key] }, owner, services };
}
function fakeLlm(stream = async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; }) {
  return {
    listProviders: () => [{ id: PROVIDER }, { id: 'codex-business' }],
    async prepareCall(config) { return { config, stream }; },
  };
}
function request(extra = {}) {
  return {
    provider: PROVIDER, model: MODEL, sessionId: SESSION,
    system: 'Exact stable instructions.', reasoningEffort: 'high', maxTokens: 8,
    tools: [{ name: 'synthetic_tool', description: 'Never execute', parameters: { type: 'object', properties: {} } }],
    toolHistory: { tools: [], updates: [] },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Stable prefix.' }] }],
    signal: new AbortController().signal,
    ...extra,
  };
}
const consume = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

test('availability uses actual account plugin, refuses ambiguous/disabled routes, and returns no store path', () => {
  const f = routeFixture(fakeLlm());
  f.owner.fiber.config.storePath = '/synthetic-private-store-path';
  const route = readCodexRoute(f.ctx, PROVIDER, MODEL);
  assert.equal(route.accountId, 'personal');
  assert.equal(route.transport, 'sse');
  assert.ok(!JSON.stringify(route).includes('synthetic-private-store-path'));
  assert.equal(readCodexRoute(f.ctx, 'codex-business').accountId, 'business');
  assert.throws(() => readCodexRoute(f.ctx, 'openai-codex'), /unsupported provider/);
  f.owner.fiber.config.models = ['different-model'];
  assert.throws(() => readCodexRoute(f.ctx, PROVIDER, MODEL), /excluded/);
  f.owner.fiber.config.models = [];
  f.owner.fiber.config.accounts.push({ id: 'wrong', provider: PROVIDER });
  assert.throws(() => readCodexRoute(f.ctx, PROVIDER), /ambiguous/);
  f.owner.fiber.config.accounts.pop();
  f.owner.fiber.config.cacheRetention = 'none';
  assert.throws(() => readCodexRoute(f.ctx, PROVIDER), /disabled/);
  f.owner.fiber.config.cacheRetention = 'long';
  f.owner.fiber.state = 4;
  assert.throws(() => readCodexRoute(f.ctx, PROVIDER), /active/);
});

test('nonvolatile applied config is authoritative, with no raw/descriptor fallback or unknown field reads', () => {
  const f = routeFixture(fakeLlm());
  assert.deepEqual(f.services.settings.describe(), []);
  f.services.settings.describe = () => assert.fail('Codex availability must not inspect volatile settings');
  f.owner.options.config = { accounts: [{ id: 'wrong-raw-account', provider: PROVIDER }] };
  Object.defineProperty(f.owner.fiber.config, 'credentials', { enumerable: true, get() { assert.fail('unreviewed config property read'); } });
  assert.equal(readCodexRoute(f.ctx, PROVIDER).accountId, 'personal');
  delete f.owner.fiber.config;
  assert.throws(() => readCodexRoute(f.ctx, PROVIDER), /live account config unavailable/);
});

test('route identity changes for account/config/owner changes without credential access', () => {
  const f = routeFixture(fakeLlm());
  const first = readCodexRoute(f.ctx, PROVIDER).identity;
  f.owner.fiber.config.accounts[0].id = 'replacement';
  const second = readCodexRoute(f.ctx, PROVIDER).identity;
  assert.notEqual(first, second);
  f.owner.fiber.uid++;
  const third = readCodexRoute(f.ctx, PROVIDER).identity;
  assert.notEqual(second, third);
  f.owner.fiber = { ...f.owner.fiber };
  assert.notEqual(third, readCodexRoute(f.ctx, PROVIDER).identity);
});

test('shadow preserves captured prefix/options but drops AgentLoop identity, text, tools and replay outputs', async () => {
  let received;
  let closed = false;
  const f = routeFixture(fakeLlm(async function* (options) {
    received = options;
    try {
      yield { type: 'text-delta', text: 'private output' };
      yield { type: 'tool-call-delta', name: 'synthetic_tool', argumentsDelta: '{}' };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 1500, cacheReadTokens: 1200, bad: 'secret' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { secret: true } };
    } finally { closed = true; }
  }));
  const original = markAgentLoopRequest(request());
  const before = structuredClone({ ...original, signal: undefined });
  const transport = await createCodexTransport(f.ctx, { provider: PROVIDER, model: MODEL });
  const chunks = await consume(transport.stream(original));
  assert.deepEqual({ ...original, signal: undefined }, before);
  assert.equal(isAgentLoopRequest(received), false);
  assert.equal(received.signal, original.signal);
  assert.deepEqual(received.messages.slice(0, -1), original.messages);
  assert.deepEqual(received.messages.at(-1), { role: 'user', content: [{ type: 'text', text: CODEX_WARM_PROMPT }] });
  assert.deepEqual(received.tools, original.tools);
  assert.deepEqual(received.toolHistory, original.toolHistory);
  assert.equal(received.reasoningEffort, 'high');
  assert.equal(received.sessionId, SESSION);
  assert.ok(CODEX_WARM_OUTPUT_RESERVATION >= 1024);
  assert.deepEqual(chunks, [
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 1500, cacheReadTokens: 1200 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]);
  assert.equal(closed, true);
});

test('no dispatch after route replacement, cancellation or changed model defaults', async () => {
  let sent = 0;
  const llm = fakeLlm(async function* () { sent++; });
  const f = routeFixture(llm);
  const transport = await createCodexTransport(f.ctx, { provider: PROVIDER, model: MODEL });
  f.owner.fiber.uid++;
  await assert.rejects(consume(transport.stream(request())), /route changed/);
  const fresh = await createCodexTransport(f.ctx, { provider: PROVIDER, model: MODEL });
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(consume(fresh.stream(request({ signal: controller.signal }))), /cancelled/);
  await assert.rejects(consume(fresh.stream(request({ provider: 'codex-business' }))), /route\/model changed/);
  await assert.rejects(consume(fresh.stream(request({ sessionId: undefined }))), /cache key/);
  llm.prepareCall = async config => ({ config: { ...config, reasoningEffort: 'low' }, stream: async function* () { sent++; } });
  await assert.rejects(consume(fresh.stream(request())), /defaults changed/);
  llm.prepareCall = async config => { f.owner.fiber.uid++; return { config, stream: async function* () { sent++; } }; };
  await assert.rejects(consume(fresh.stream(request())), /route changed/);
  assert.equal(sent, 0);
});

test('one attempt only and provider error text cannot escape the warmer', async () => {
  let attempts = 0;
  const f = routeFixture(fakeLlm(async function* () {
    attempts++;
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'sensitive provider echo' } } };
  }));
  const transport = await createCodexTransport(f.ctx, { provider: PROVIDER, model: MODEL });
  const chunks = await consume(transport.stream(request()));
  assert.equal(attempts, 1);
  assert.equal(chunks[0].reason.failure.code, 'RATE_LIMIT');
  assert.equal(chunks[0].reason.failure.status, 429);
  assert.ok(!JSON.stringify(chunks).includes('sensitive'));
});

test('in-flight cancellation and consumer return close the stream without dispatching outputs', async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let closed = false;
  const f = routeFixture(fakeLlm(async function* (options) {
    try {
      entered();
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'text-delta', text: 'must not escape after cancellation' };
    } finally { closed = true; }
  }));
  const transport = await createCodexTransport(f.ctx, { provider: PROVIDER, model: MODEL });
  const pending = consume(transport.stream(request({ signal: controller.signal })));
  await started;
  controller.abort(new Error('foreground request started'));
  await assert.rejects(pending, /foreground request started/);
  assert.equal(closed, true);

  closed = false;
  f.services.llm.prepareCall = async config => ({ config, stream: async function* () {
    try {
      yield { type: 'usage', usage: { inputTokens: 1 } };
      assert.fail('consumer return must not advance the stream');
    } finally { closed = true; }
  } });
  for await (const _chunk of transport.stream(request())) break;
  assert.equal(closed, true);
});

function syntheticToken(accountId, generation) {
  return `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId }, generation })).toString('base64url')}.not-a-signature`;
}
function sse() {
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  return [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 1600, output_tokens: 2, total_tokens: 1602, input_tokens_details: { cached_tokens: 1500 } } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

test('real installed alias adapter + public LLM prepareCall preserve wire prefix, native attachments and fresh account auth', async t => {
  const requests = [];
  let errorResponse = false;
  const server = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const bytes = Buffer.concat(parts);
    requests.push({ headers: req.headers, url: req.url, body: JSON.parse((req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString()) });
    if (errorResponse) {
      res.writeHead(429, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: { message: 'offline rate limit fixture' } }));
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.end(sse());
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const catalog = openaiCodexProvider();
  const catalogModel = catalog.getModels().find(model => model.id === MODEL);
  assert.ok(catalogModel);
  const localProvider = { ...catalog, baseUrl, getModels: () => [{ ...catalogModel, baseUrl }] };
  const authReads = [];
  let generation = 1;
  const store = {
    async read(accountId) {
      authReads.push(accountId);
      return { type: 'oauth', access: syntheticToken(`fixture-${accountId}`, generation), refresh: 'unused-fixture', expires: Date.now() + 3_600_000 };
    },
    async modify() { assert.fail('fixture auth must not refresh'); },
  };
  const core = new Context();
  const runtimeFiber = core.plugin(LlmRuntime); await runtimeFiber.await();
  t.after(() => runtimeFiber.dispose());
  const llm = core.get('llm');
  const removers = [];
  const imageReads = [];
  for (const [provider, accountId] of [[PROVIDER, 'personal'], ['codex-business', 'business']]) {
    const models = createModels({ credentials: accountScopedStore(store, accountId), authContext: { env: async () => undefined, fileExists: async () => false } });
    models.setProvider(localProvider);
    const adapter = new CodexAccountAdapter({ provider, models, transport: 'sse', cacheRetention: 'long', readImages: true, streamIdleTimeoutMs: 2000,
      resolveAttachments: () => ({ async readImageRequest(ref, target) { imageReads.push({ ref, target }); return { data: new Uint8Array([1, 2, 3]), bytes: 3, width: 2, height: 2, mediaType: 'image/png' }; } }),
      resolveImageAccess: () => ({ hostPath: '/offline/fixture.png', processPath: '/offline/fixture.png' }),
      requestImagePolicy: { maxPixels: 4_194_304, maxBytes: 1_048_576 }, maxRequestImageBytes: 20 * 1024 * 1024,
    });
    removers.push(llm.registerAdapter([provider], adapter));
  }
  t.after(async () => { for (const remove of removers) await remove(); });
  const f = routeFixture(llm);
  const options = request({ signal: AbortSignal.timeout(5000), temperature: 0.1,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Stable prefix.' }, { type: 'image', attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', width: 2, height: 2, bytes: 3 } }, { type: 'file', attachment: { attachmentId: 'fixture-file', name: 'fixture.txt', bytes: 12 } }] },
      { role: 'assistant', id: 'a1', source: { kind: 'model', provider: PROVIDER, model: MODEL }, content: [{ type: 'text', text: 'Prior answer.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
    ],
  });
  const before = structuredClone({ ...options, signal: undefined });
  // Real foreground-equivalent serialization baseline, but ONLY to loopback.
  const baselineChunks = await consume(llm.stream(options));
  assert.equal(baselineChunks.at(-1)?.reason?.kind, 'stop', JSON.stringify(baselineChunks));
  const transport = await createCodexTransport(f.ctx, { provider: PROVIDER, model: MODEL });
  generation = 2;
  const warm = await consume(transport.stream(markAgentLoopRequest(options)));
  assert.equal(requests.length, 2);
  assert.deepEqual({ ...options, signal: undefined }, before);
  const baseline = requests[0].body;
  const body = requests[1].body;
  assert.deepEqual({ ...body, input: body.input.slice(0, -1) }, baseline);
  assert.equal(body.input.at(-1).role, 'user');
  assert.equal(body.input.at(-1).content[0].text, CODEX_WARM_PROMPT);
  assert.equal(body.prompt_cache_key, SESSION);
  assert.equal(body.model, MODEL);
  assert.equal(body.reasoning.effort, baseline.reasoning.effort);
  assert.equal(body.tool_choice, 'auto', 'public owning adapter does not expose tool_choice override');
  assert.ok(body.tools.length > 0);
  assert.equal(Object.hasOwn(body, 'max_output_tokens'), false, 'must not claim hard output bound');
  assert.equal(requests[1].url, '/codex/responses');
  assert.equal(requests[1].headers['chatgpt-account-id'], 'fixture-personal');
  assert.notEqual(requests[0].headers.authorization, requests[1].headers.authorization);
  assert.deepEqual(authReads, ['personal', 'personal']);
  assert.equal(imageReads.length, 2);
  assert.deepEqual(imageReads[0], imageReads[1]);
  assert.ok(warm.every(chunk => chunk.type === 'usage' || chunk.type === 'finish'));
  assert.equal(warm.find(chunk => chunk.type === 'usage')?.usage.cacheReadTokens, 1500);
  assert.equal(warm.at(-1).reason.kind, 'stop');
  const business = await createCodexTransport(f.ctx, { provider: 'codex-business', model: MODEL });
  await consume(business.stream(request({ provider: 'codex-business', signal: AbortSignal.timeout(5000) })));
  assert.equal(requests.length, 3);
  assert.equal(requests[2].headers['chatgpt-account-id'], 'fixture-business');
  assert.equal(authReads.at(-1), 'business');
  errorResponse = true;
  const failed = await consume(business.stream(request({ provider: 'codex-business', signal: AbortSignal.timeout(5000) })));
  assert.equal(failed.at(-1).reason.kind, 'error');
  assert.equal(requests.length, 4, 'real installed SSE transport must not retry a failed warm request');
  assert.ok(!JSON.stringify(failed).includes('offline rate limit fixture'));
});
