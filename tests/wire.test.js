import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { buildBoundedAdapter, openRouterModelSupport, OPENROUTER_MODEL } from '../lib/openrouter.js';

// Resolve the adapter's own nested pi-ai catalog, not a second installed copy.
const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'));
const { openrouterProvider } = await import(new URL('./dist/providers/openrouter.js', pathToFileURL(manifest)).href);
const SESSION_ID = 'offline-wire-session-42';
const KEY = 'offline-test-key-not-a-credential';
const consume = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

function inertAuth() {
  return {
    credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new Error('no ambient auth'); }, delete: async () => {} },
    authContext: { env: async () => undefined, fileExists: async () => false },
  };
}
function baselineAdapter(provider, route) {
  const profiles = new Map([['openrouter', {
    provider: 'openrouter', ...route, streamIdleTimeoutMs: 10_000,
    retryPolicy: { mode: 'normal', maxRetries: 0 }, configuredMaxTokens: new Map(), modelErrors: new Map(), piProvider: provider,
  }]]);
  return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => KEY, auth: inertAuth() });
}
function makeSseResponse(model) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-offline-fixture', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: { content: 'offline-ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2048, completion_tokens: 1, total_tokens: 2049, prompt_tokens_details: { cached_tokens: 1024 } },
  })}\n\ndata: [DONE]\n\n`;
}
const replayDetails = [{ type: 'reasoning.encrypted', id: 'offline-thought', data: 'synthetic-replay-data', format: 'unknown', index: 0 }];
function request(model, reasoningEffort) {
  return {
    provider: 'openrouter', model, sessionId: SESSION_ID,
    system: 'stable offline wire-test prefix', maxTokens: 8, reasoningEffort, temperature: .2,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'synthetic stable history' }] },
      { role: 'assistant', id: 'assistant-1', source: {
        kind: 'model', provider: 'openrouter', model,
        replayState: {
          response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'openrouter', model, stopReason: 'toolUse' },
          blocks: [{ type: 'reasoning', thinkingSignature: JSON.stringify(replayDetails) }, { type: 'tool-call' }],
        },
      }, content: [
        { type: 'reasoning', text: 'synthetic prior reasoning' },
        { type: 'tool-call', id: 'fixture-call', name: 'fixture_echo', arguments: '{"value":"prior"}' },
      ] },
      { role: 'tool', toolCallId: 'fixture-call', content: [{ type: 'text', text: 'synthetic tool result' }] },
      { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
    ],
    tools: [{ name: 'fixture_echo', description: 'Synthetic serialization fixture; never executed.', parameters: {
      type: 'object', properties: { value: { type: 'string' } }, required: ['value'],
    } }],
  };
}

test('multiple catalog families preserve native prefix, tools, replay, reasoning, retention and session routing', async (t) => {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'close' });
    res.end(makeSseResponse(body.model));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const catalog = openrouterProvider();
  const local = { ...catalog, baseUrl: base, getModels: () => catalog.getModels().map((model) => ({ ...model, baseUrl: base })) };
  const cases = [
    { model: OPENROUTER_MODEL, effort: 'off', wireEffort: 'none', retention: 'short', role: 'system' },
    { model: 'deepseek/deepseek-chat', effort: 'off', wireEffort: undefined, retention: 'long', role: 'system' },
    { model: 'openai/gpt-4.1', effort: 'off', wireEffort: undefined, retention: 'long', role: 'system' },
    { model: 'openai/gpt-5', effort: 'high', wireEffort: 'high', retention: 'short', role: 'developer' },
    { model: 'google/gemini-2.5-pro', effort: 'high', wireEffort: 'high', retention: 'long', role: 'system' },
    { model: 'meta-llama/llama-3.3-70b-instruct', effort: 'off', wireEffort: undefined, retention: 'none', role: 'system' },
    { model: 'anthropic/claude-sonnet-4.5:batch', effort: 'high', wireEffort: 'high', retention: 'long', role: 'developer' },
  ];
  for (const fixture of cases) await t.test(fixture.model, async () => {
    assert.equal(openRouterModelSupport(fixture.model).supported, true);
    const options = request(fixture.model, fixture.effort);
    const original = structuredClone(options);
    const route = { cacheRetention: fixture.retention };
    const baseline = baselineAdapter(local, route);
    const bounded = buildBoundedAdapter({ modelId: fixture.model, catalogProvider: local, route, expectedBase: base, resolveApiKey: async () => KEY });
    const before = received.length;
    const normalChunks = await consume(baseline.stream(options));
    assert.equal(normalChunks.at(-1)?.reason?.kind, 'stop', JSON.stringify(normalChunks));
    const chunks = await consume(bounded.stream(options));
    assert.equal(chunks.at(-1)?.reason?.kind, 'stop', JSON.stringify(chunks));
    assert.equal(received.length, before + 2, 'exactly one native request per stream, both loopback');
    assert.deepEqual(options, original, 'captured request must not be mutated');
    const normal = received[before];
    const warm = received[before + 1];
    const { provider: routing, ...warmBody } = warm.body;
    assert.deepEqual(warmBody, normal.body, 'routing constraints are the ONLY native payload difference');
    assert.equal(warm.method, 'POST');
    assert.equal(warm.url, '/v1/chat/completions');
    assert.equal(warm.headers.authorization, `Bearer ${KEY}`);
    assert.equal(warm.headers['x-session-id'], fixture.retention === 'none' ? undefined : SESSION_ID);
    assert.equal(warm.body.model, fixture.model);
    assert.equal(warm.body.max_completion_tokens, 8, 'reasoning never adds output tokens');
    assert.equal(Object.hasOwn(warm.body, 'max_tokens'), false);
    assert.equal(warm.body.reasoning?.effort, fixture.wireEffort);
    assert.equal(warm.body.messages[0].role, fixture.role);
    assert.equal(warm.body.tools[0].function.name, 'fixture_echo');
    assert.deepEqual(warm.body.tools[0].function.parameters.required, ['value']);
    const assistant = warm.body.messages.find((message) => message.role === 'assistant');
    assert.deepEqual(assistant.reasoning_details, replayDetails, 'preserve opaque same-model replay');
    assert.equal(assistant.tool_calls[0].function.name, 'fixture_echo');
    assert.ok(warm.body.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'fixture-call'));
    assert.equal(routing.require_parameters, true);
    assert.equal(routing.allow_fallbacks, false);
    assert.equal(routing.max_price.request, 0);
    const cost = catalog.getModels().find((model) => model.id === fixture.model).cost;
    assert.ok(routing.max_price.prompt >= cost.input);
    assert.ok(routing.max_price.completion >= cost.output);
    if (fixture.retention === 'long') assert.equal(warm.body.prompt_cache_retention, '24h');
    if (fixture.model.startsWith('anthropic/')) assert.ok(JSON.stringify(warm.body.messages).includes('"ttl":"1h"'), 'preserve native explicit cache control');
    assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'offline-ok'));
    assert.ok(chunks.some((chunk) => chunk.type === 'usage' && chunk.usage.cacheReadTokens === 1024));
  });
});
