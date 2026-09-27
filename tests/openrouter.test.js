import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Config } from '@deepseek-ai/dsh-llm-pi-ai';
import { buildBoundedAdapter, createBoundedOpenRouter, openRouterModelSupport, readOpenRouterRoute, validateBoundedPayload, OPENROUTER_MODEL, OPENROUTER_BASE, MAX_WIRE_BYTES } from '../lib/openrouter.js';
const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'));
const { openrouterProvider } = await import(new URL('./dist/providers/openrouter.js', pathToFileURL(manifest)).href);
const catalog = openrouterProvider();
const consume = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const optionsFor = (model = OPENROUTER_MODEL) => ({ provider: 'openrouter', model, maxTokens: 8, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });

function context(route = { apiKeyEnv: 'TEST_OPENROUTER_KEY' }) {
  const state = { route, revision: 1, authReads: 0, resolve: async () => ({ value: 'offline-placeholder' }) };
  const services = {
    configEditor: { entries: () => [{ options: { id: 'pi', name: '@deepseek-ai/dsh-llm-pi-ai' }, fiber: { state: 2 } }] },
    settings: { describe: () => [{ ns: 'pi', revision: state.revision, value: { providers: { openrouter: state.route } } }] },
    credentials: { resolve: async () => { state.authReads++; return state.resolve(); } },
  };
  return { get: (key) => services[key], state };
}
function modelFixture(patch) {
  const model = { ...structuredClone(catalog.getModels().find((m) => m.id === OPENROUTER_MODEL)), ...patch };
  return { ...catalog, getModels: () => [model] };
}
function inspectAdapter(provider = catalog, extra = {}) {
  let config;
  class Adapter { constructor(value) { config = value; } }
  buildBoundedAdapter({ modelId: OPENROUTER_MODEL, catalogProvider: provider, route: {}, resolveApiKey: async () => 'offline', Adapter, ...extra });
  return config.profiles().get('openrouter').piProvider.getModels()[0];
}

test('route admission is explicit, active, and refuses custom settings', () => {
  assert.equal(readOpenRouterRoute(context()).apiKeyEnv, 'TEST_OPENROUTER_KEY');
  for (const key of ['baseURL', 'models', 'api', 'openRouterRouting']) {
    assert.throws(() => readOpenRouterRoute(context({ apiKeyEnv: 'TEST_OPENROUTER_KEY', [key]: {} })), (error) => error.reasonCode === 'unsupported-route');
  }
  assert.throws(() => readOpenRouterRoute(context({})), /explicit credential/);
});
test('materialized schema defaults accepted but actual overrides refused', () => {
  const route = Config({ providers: { openrouter: { apiKeyEnv: 'TEST_OPENROUTER_KEY' } } }).providers.get().openrouter;
  assert.equal(readOpenRouterRoute(context(route)).apiKeyEnv, 'TEST_OPENROUTER_KEY');
  for (const patch of [
    { models: [{ id: 'custom' }] }, { modelOverrides: { custom: {} } },
    { headers: { 'x-custom': 'value' } }, { thinkingBudgets: { low: 100 } },
    { compat: { supportsStore: false } }, { compat: { chatTemplateArgs: { thinking: true } } },
    { defaultContextWindow: 1 }, { defaultMaxTokens: 1 }, { defaultInput: ['text', 'image'] },
  ]) assert.throws(() => readOpenRouterRoute(context({ ...route, ...patch })), /custom endpoint/);
});
test('synchronous support and builder share installed exact-model protocol admission', () => {
  for (const modelId of [OPENROUTER_MODEL, 'deepseek/deepseek-chat', 'openai/gpt-4.1', 'openai/gpt-5', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct']) {
    assert.deepEqual(openRouterModelSupport(modelId), { supported: true, reasonCode: null });
    const admitted = inspectAdapter(catalog, { modelId });
    assert.equal(admitted.id, modelId);
    const { openRouterRouting, ...compat } = admitted.compat;
    assert.deepEqual(compat, catalog.getModels().find((m) => m.id === modelId).compat, 'preserves this model compatibility, not DeepSeek defaults');
    assert.equal(openRouterRouting.max_price.request, 0);
  }
  for (const id of [undefined, '', '*', OPENROUTER_MODEL.toUpperCase(), 'not-a-model', 'auto', 'openrouter/free']) {
    assert.deepEqual(openRouterModelSupport(id), { supported: false, reasonCode: 'unsupported-model' });
  }
  assert.deepEqual(openRouterModelSupport('anthropic/claude-3-haiku'), { supported: false, reasonCode: 'unsupported-protocol' });
  assert.throws(() => inspectAdapter(catalog, { modelId: 'anthropic/claude-3-haiku' }), /unsupported-protocol/);
  assert.throws(() => inspectAdapter(catalog, { modelId: undefined }), /unsupported-model/);
});
test('catalog-wide support never disagrees with construction', () => {
  for (const model of catalog.getModels()) {
    const support = openRouterModelSupport(model.id);
    if (support.supported) assert.equal(inspectAdapter(catalog, { modelId: model.id }).id, model.id);
    else assert.throws(() => inspectAdapter(catalog, { modelId: model.id }), (error) => error.reasonCode === support.reasonCode);
  }
});
test('prices use catalog maxima across every tier, including expensive and free models', () => {
  const expensive = inspectAdapter(catalog, { modelId: 'openai/gpt-4.1' });
  assert.deepEqual(expensive.compat.openRouterRouting.max_price, { prompt: 2, completion: 8, request: 0 });
  const cost = { input: 3, output: 15, cacheRead: 1, cacheWrite: 4, tiers: [
    { inputTokensAbove: 200_000, input: 6, output: 30, cacheRead: 2, cacheWrite: 8 },
    { inputTokensAbove: 500_000, input: 12, output: 60, cacheRead: 3, cacheWrite: 16 },
  ] };
  assert.deepEqual(inspectAdapter(modelFixture({ cost })).compat.openRouterRouting.max_price, { prompt: 16, completion: 60, request: 0 });
  assert.deepEqual(inspectAdapter(modelFixture({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })).compat.openRouterRouting.max_price, { prompt: 0, completion: 0, request: 0 });
  for (const bad of [undefined, {}, { ...cost, input: -1 }, { ...cost, output: NaN }, { ...cost, tiers: {} },
    { ...cost, tiers: [{ inputTokensAbove: 1, output: 2 }] }, { ...cost, request: .01 }, { ...cost, image: 1 }]) {
    assert.throws(() => inspectAdapter(modelFixture({ cost: bad })), /unknown-pricing/);
  }
});
test('unknown endpoint, serializer, compat and payload overrides fail closed', () => {
  assert.throws(() => inspectAdapter({ ...catalog, baseUrl: 'https://other.invalid' }), /unsupported-route/);
  assert.throws(() => inspectAdapter({ ...catalog, headers: { authorization: 'not-a-key' } }), /unsupported-route/);
  for (const patch of [{ baseUrl: 'https://other.invalid' }, { provider: 'other' }]) assert.throws(() => inspectAdapter(modelFixture(patch)), /unsupported-route/);
  for (const api of ['anthropic-messages', 'openai-responses', 'new-api']) assert.throws(() => inspectAdapter(modelFixture({ api })), /unsupported-protocol/);
  for (const patch of [
    { samplingParams: { max_tokens: 100 } }, { headers: { 'x-extra': 'value' } },
    { compat: { thinkingFormat: 'deepseek' } }, { compat: { maxTokensField: 'unknown' } },
    { compat: { openRouterRouting: { allow_fallbacks: true } } }, { compat: { newSerializerSwitch: true } },
    { compat: { sendSessionAffinityHeaders: false } }, { input: ['image'] }, { maxTokens: 0 },
  ]) assert.throws(() => inspectAdapter(modelFixture(patch)), /unsupported-capability/);
});
test('final payload guard requires bound identity, caps and safe native serialization', () => {
  const modelId = 'openai/gpt-4.1';
  const routingCaps = inspectAdapter(catalog, { modelId }).compat.openRouterRouting;
  const guard = { modelId, routingCaps };
  const body = { model: modelId, stream: true, max_completion_tokens: 8, provider: routingCaps, messages: [] };
  validateBoundedPayload(body, guard);
  assert.throws(() => validateBoundedPayload(body), /wire identity/);
  assert.throws(() => validateBoundedPayload({ ...body, model: OPENROUTER_MODEL }, guard), /wire identity/);
  assert.throws(() => validateBoundedPayload(body, { ...guard, maxInputBytes: 1 }), /input budget/);
  assert.throws(() => validateBoundedPayload({ ...body, provider: {} }, guard), /caps missing/);
  assert.throws(() => validateBoundedPayload({ ...body, provider: { ...routingCaps, allow_fallbacks: true } }, guard), /caps missing/);
  for (const max_completion_tokens of [0, 9, 1000, '8']) assert.throws(() => validateBoundedPayload({ ...body, max_completion_tokens }, guard), /1–8/);
  assert.throws(() => validateBoundedPayload({ ...body, max_tokens: 8 }, guard), /ambiguous/);
  assert.throws(() => validateBoundedPayload({ ...body, messages: [{ content: 'x'.repeat(MAX_WIRE_BYTES) }] }, guard), /input budget/);
  for (const key of ['models', 'plugins', 'web_search_options', 'modalities', 'audio', 'sampling_params']) assert.throws(() => validateBoundedPayload({ ...body, [key]: {} }, guard), /unsupported serialization/);
  assert.throws(() => validateBoundedPayload({ ...body, reasoning: { max_tokens: 1000 } }, guard), /reasoning serialization/);
  assert.throws(() => validateBoundedPayload({ ...body, messages: [{ content: [{ type: 'image_url', image_url: { url: 'https://invalid' } }] }] }, guard), /text context/);
});
test('capability rejects wrong model, provider, bounds and attachments before auth', async () => {
  let authReads = 0;
  const adapter = buildBoundedAdapter({ modelId: 'openai/gpt-4.1', catalogProvider: catalog, route: {}, resolveApiKey: async () => { authReads++; throw new Error('must not resolve'); } });
  for (const patch of [{ model: OPENROUTER_MODEL }, { provider: 'elsewhere' }, { maxTokens: 9 },
    { messages: [{ role: 'user', content: [{ type: 'image' }] }] },
    { messages: [{ role: 'tool', content: [{ type: 'file' }] }] },
  ]) await assert.rejects(consume(adapter.stream({ ...optionsFor('openai/gpt-4.1'), ...patch })), /unsupported route\/model|1–8|text context/);
  assert.equal(authReads, 0);
});
test('production creation is credential-free and route identity rechecked across auth await', async () => {
  const f = context();
  await assert.rejects(createBoundedOpenRouter(f), /unsupported-model/);
  const adapter = await createBoundedOpenRouter(f, { model: 'openai/gpt-4.1' });
  assert.equal(f.state.authReads, 0);
  f.state.revision++;
  await assert.rejects(consume(adapter.stream(optionsFor('openai/gpt-4.1'))), /route changed/);
  assert.equal(f.state.authReads, 0);
  const adapter2 = await createBoundedOpenRouter(f, { model: 'openai/gpt-4.1' });
  f.state.resolve = async () => { f.state.route.cacheRetention = 'long'; return { value: 'offline-placeholder' }; };
  await assert.rejects(consume(adapter2.stream(optionsFor('openai/gpt-4.1'))), /route changed/);
  assert.equal(f.state.authReads, 1, 'no real credentials or network involved');
});

test('bounded production serializer applies per-model caps and never retries', async (t) => {
  let received;
  let calls = 0;
  let fail = false;
  const server = createServer(async (req, res) => {
    calls++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { body: JSON.parse(Buffer.concat(chunks).toString()), headers: req.headers };
    if (fail) { res.writeHead(503); res.end('{"error":{"message":"offline failure"}}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: received.body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2048, completion_tokens: 1, total_tokens: 2049, prompt_tokens_details: { cached_tokens: 1024 } } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const local = { ...catalog, baseUrl: base, getModels: () => catalog.getModels().map((m) => ({ ...m, baseUrl: base })) };
  const adapter = buildBoundedAdapter({ modelId: OPENROUTER_MODEL, catalogProvider: local, route: {}, expectedBase: base, resolveApiKey: async () => 'offline-placeholder' });
  const options = { ...optionsFor(), sessionId: 'bounded-offline', reasoningEffort: 'off', system: 'stable prefix', tools: [{ name: 'fixture', description: 'never executed', parameters: { type: 'object', properties: {} } }] };
  const output = await consume(adapter.stream(options));
  assert.equal(calls, 1);
  assert.deepEqual(received.body.provider.max_price, { prompt: .03, completion: .8, request: 0 });
  assert.equal(received.body.provider.allow_fallbacks, false);
  assert.equal(received.body.provider.require_parameters, true);
  assert.equal(received.body.max_completion_tokens, 8);
  assert.equal(received.headers['x-session-id'], options.sessionId);
  assert.equal(received.body.messages[0].content, 'stable prefix');
  assert.equal(received.body.tools[0].function.name, 'fixture');
  assert.equal(received.body.reasoning.effort, 'none');
  assert.ok(output.some((c) => c.type === 'usage' && c.usage.cacheReadTokens === 1024));
  const before = calls;
  const oversize = await consume(adapter.stream({ ...options, system: 'x'.repeat(MAX_WIRE_BYTES) }));
  assert.equal(oversize.at(-1).reason.kind, 'error');
  assert.equal(calls, before, 'oversize must not reach loopback server');
  fail = true;
  await consume(adapter.stream(options));
  assert.equal(calls, before + 1, '503 must not retry');
  // The production endpoint is never selected by this test.
  assert.notEqual(base, OPENROUTER_BASE);
});
