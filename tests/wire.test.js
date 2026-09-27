import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// This plugin is intentionally not coupled to dsh-llm-pi-ai. For the wire
// contract test, load the adapter installed with the running DSH distribution
// and its own nested pi-ai copy (the copy whose catalog the adapter uses).
const nodeInstall = resolve(dirname(process.execPath), '..');
const adapterRoot = resolve(
  nodeInstall,
  'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai',
);
const adapterEntry = join(adapterRoot, 'lib/index.js');
const piRoot = join(adapterRoot, 'node_modules/@earendil-works/pi-ai');
const adapterModule = await import(pathToFileURL(adapterEntry).href);
const { openrouterProvider } = await import(
  pathToFileURL(join(piRoot, 'dist/providers/openrouter.js')).href,
);
const { getBuiltinModels } = await import(
  pathToFileURL(join(piRoot, 'dist/providers/all.js')).href,
);

const MODEL_ID = '~deepseek/deepseek-v4-flash-latest';
const SESSION_ID = 'offline-wire-session-42';

function inertAuth() {
  return {
    credentials: {
      async read() { return undefined; },
      async list() { return []; },
      async modify(_providerId, update) { return update(undefined); },
      async delete() {},
    },
    authContext: {
      async env() { return undefined; },
      async fileExists() { return false; },
    },
  };
}

function makeSseResponse(model) {
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl-offline-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: 'offline-ok' }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl-offline-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

test('OpenRouter catalog request keeps the DSH session id and exact completion-token field', async (t) => {
  const catalogEntry = getBuiltinModels('openrouter').find((model) => model.id === MODEL_ID);
  assert.ok(catalogEntry, `installed pi-ai catalog must contain ${MODEL_ID}`);
  assert.equal(catalogEntry.api, 'openai-completions');
  assert.equal(catalogEntry.provider, 'openrouter');

  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    response.end(makeSseResponse(MODEL_ID));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  }));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const localBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  const catalogProvider = openrouterProvider();
  const localProvider = {
    ...catalogProvider,
    baseUrl: localBaseUrl,
    // Preserve the installed catalog model and compat metadata, changing only
    // its endpoint so this test cannot reach OpenRouter.
    getModels: () => catalogProvider.getModels().map((model) => model.id === MODEL_ID
      ? { ...model, baseUrl: localBaseUrl }
      : model),
  };
  const profile = {
    provider: 'openrouter',
    displayName: 'OpenRouter (offline wire fixture)',
    streamIdleTimeoutMs: 10_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: { mode: 'normal', maxRetries: 0 },
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    piProvider: localProvider,
  };
  const profiles = new Map([['openrouter', profile]]);
  const adapter = new adapterModule.PiAiAdapter({
    profiles: () => profiles,
    // A synthetic test key is passed only to the loopback server.
    resolveApiKey: async () => 'offline-test-key-not-a-credential',
    auth: inertAuth(),
  });

  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: 'openrouter',
    model: MODEL_ID,
    system: 'stable offline wire-test prefix',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic test only' }] }],
    tools: [{
      name: 'fixture_echo',
      description: 'Synthetic serialization fixture; never executed.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    }],
    maxTokens: 7,
    reasoningEffort: 'off',
    sessionId: SESSION_ID,
  })) chunks.push(chunk);

  assert.ok(received, 'adapter must send exactly one request to the loopback server');
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.headers['x-session-id'], SESSION_ID);
  assert.equal(received.headers.authorization, 'Bearer offline-test-key-not-a-credential');
  assert.equal(received.body.model, MODEL_ID);
  assert.equal(received.body.max_completion_tokens, 7);
  assert.equal(Object.hasOwn(received.body, 'max_tokens'), false);
  assert.equal(received.body.messages[0].role, 'system');
  assert.match(received.body.messages[0].content, /stable offline wire-test prefix/);
  assert.equal(received.body.tools[0].function.name, 'fixture_echo');
  assert.deepEqual(received.body.tools[0].function.parameters.required, ['value']);
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'offline-ok'));
});
