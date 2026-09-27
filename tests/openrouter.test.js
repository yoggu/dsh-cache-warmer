import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Config } from '@deepseek-ai/dsh-llm-pi-ai';
import { buildBoundedAdapter, inputBytesForBudget, readOpenRouterRoute, validateBoundedPayload, OPENROUTER_MODEL, ROUTING_CAPS, MAX_WIRE_BYTES } from '../lib/openrouter.js';
const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'));
const { openrouterProvider } = await import(new URL('./dist/providers/openrouter.js', pathToFileURL(manifest)).href);

test('budget-derived input bounds reserve three uncached attempts', () => {
  for (const budget of [.05, 1, 10]) {
    const bytes = inputBytesForBudget(budget);
    assert.ok(bytes > 0 && bytes <= MAX_WIRE_BYTES);
    assert.ok(3 * ((2 * bytes + 8192) * .000001 + 8 * .000002) <= budget);
  }
  assert.throws(() => inputBytesForBudget(NaN));
});

function context(route = { apiKeyEnv: 'TEST_OPENROUTER_KEY' }) {
  const services = {
    configEditor: { entries: () => [{ options: { id: 'pi', name: '@deepseek-ai/dsh-llm-pi-ai' }, fiber: { state: 2 } }] },
    settings: { describe: () => [{ ns: 'pi', revision: 1, value: { providers: { openrouter: route } } }] },
    credentials: {},
  };
  return { get: (key) => services[key] };
}
test('route admission is explicit, active, and refuses custom settings', () => {
  assert.equal(readOpenRouterRoute(context()).apiKeyEnv, 'TEST_OPENROUTER_KEY');
  for (const key of ['baseURL', 'models', 'api', 'openRouterRouting']) {
    assert.throws(() => readOpenRouterRoute(context({ apiKeyEnv: 'TEST_OPENROUTER_KEY', [key]: {} })), /custom endpoint/);
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
test('final payload guard rejects absent caps and input/output excess', () => {
  const body = { model: OPENROUTER_MODEL, stream: true, max_completion_tokens: 8, provider: ROUTING_CAPS, messages: [] };
  validateBoundedPayload(body);
  assert.throws(() => validateBoundedPayload(body, 1), /input budget/);
  assert.throws(() => validateBoundedPayload({ ...body, provider: {} }), /caps missing/);
  assert.throws(() => validateBoundedPayload({ ...body, max_completion_tokens: 9 }), /1–8/);
  assert.throws(() => validateBoundedPayload({ ...body, messages: ['x'.repeat(MAX_WIRE_BYTES)] }), /input budget/);
});

test('bounded production serializer puts caps on wire, preserves session/tools/reasoning, makes no retry', async (t) => {
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
    res.end(`data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: OPENROUTER_MODEL, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2048, completion_tokens: 1, total_tokens: 2049, prompt_tokens_details: { cached_tokens: 1024 } } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const catalog = openrouterProvider();
  const local = { ...catalog, baseUrl: base, getModels: () => catalog.getModels().map((m) => ({ ...m, baseUrl: base })) };
  const adapter = buildBoundedAdapter({ catalogProvider: local, route: {}, expectedBase: base, resolveApiKey: async () => 'offline-placeholder' });
  const options = { provider: 'openrouter', model: OPENROUTER_MODEL, maxTokens: 8, sessionId: 'bounded-offline', reasoningEffort: 'off', system: 'stable prefix', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [{ name: 'fixture', description: 'never executed', parameters: { type: 'object', properties: {} } }] };
  const output = [];
  for await (const chunk of adapter.stream(options)) output.push(chunk);
  assert.equal(calls, 1);
  assert.deepEqual(received.body.provider, ROUTING_CAPS);
  assert.equal(received.body.max_completion_tokens, 8);
  assert.equal(received.headers['x-session-id'], options.sessionId);
  assert.equal(received.body.messages[0].content, 'stable prefix');
  assert.equal(received.body.tools[0].function.name, 'fixture');
  assert.equal(received.body.reasoning.effort, 'none');
  assert.ok(output.some((c) => c.type === 'usage' && c.usage.cacheReadTokens === 1024));
  const before = calls;
  for await (const _ of adapter.stream({ ...options, system: 'x'.repeat(MAX_WIRE_BYTES) })) {}
  assert.equal(calls, before, 'oversize must not reach loopback server');
  fail = true;
  for await (const _ of adapter.stream(options)) {}
  assert.equal(calls, before + 1, '503 must not retry');
});
