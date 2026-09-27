import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

export const OPENROUTER_MODEL = '~deepseek/deepseek-v4-flash-latest';
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const ROUTING_CAPS = Object.freeze({
  require_parameters: true,
  allow_fallbacks: false,
  max_price: Object.freeze({ prompt: 1, completion: 2, request: 0 }),
});
// Independent request-size ceiling, not a user-facing monetary budget.
export const MAX_WIRE_BYTES = 1_048_576;
const PACKAGE = '@deepseek-ai/dsh-llm-pi-ai';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function reject(reason) { throw new Error(`Bounded OpenRouter unavailable: ${reason}`); }

/** Inspect only the exact active route; never return config values or credentials. */
export function readOpenRouterRoute(ctx) {
  const entries = ctx.get('configEditor')?.entries() ?? [];
  const owners = entries.filter((entry) => entry.options?.name === PACKAGE && entry.fiber?.state === 2);
  if (owners.length !== 1) reject('requires exactly one active pi-ai configuration');
  const owner = owners[0];
  const ns = owner.options.id;
  const settings = ctx.get('settings')?.describe({ redactSecrets: true });
  const descriptor = settings?.find((item) => item.ns === ns);
  // Volatile providers must come from the current settings projection. Refuse
  // to guess from an inherited raw profile if that projection is unavailable.
  if (!descriptor || !descriptor.value || typeof descriptor.value !== 'object') reject('live provider settings unavailable');
  const configured = descriptor.value.providers?.openrouter;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) reject('openrouter route is not configured');
  const route = structuredClone(configured);
  // Verified pi-ai Config materializations, not permission to accept actual
  // overrides. In particular compat's two empty template dicts are defaults.
  const emptyObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  if (Array.isArray(route.models) && route.models.length === 0) delete route.models;
  for (const key of ['modelOverrides', 'headers', 'thinkingBudgets']) if (emptyObject(route[key])) delete route[key];
  if (route.compat && typeof route.compat === 'object' && !Array.isArray(route.compat)) {
    for (const key of ['chatTemplateKwargs', 'chatTemplateArgs']) if (emptyObject(route.compat[key])) delete route.compat[key];
    if (emptyObject(route.compat)) delete route.compat;
  }
  if (route.defaultContextWindow === 262144) delete route.defaultContextWindow;
  if (route.defaultMaxTokens === 32768) delete route.defaultMaxTokens;
  if (Array.isArray(route.defaultInput) && route.defaultInput.length === 1 && route.defaultInput[0] === 'text') delete route.defaultInput;
  const allowed = new Set(['apiKeyEnv', 'displayName', 'cacheRetention', 'reasoning', 'transport', 'timeoutMs', 'websocketConnectTimeoutMs', 'streamIdleTimeoutMs', 'retryPolicy', 'requestImagePixelBudget', 'requestImageMaxBytes', 'maxRequestImageBytes']);
  if (Object.keys(route).some((key) => !allowed.has(key))) reject('custom endpoint, models, headers, protocol or unknown route controls');
  if (typeof route.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(route.apiKeyEnv)) reject('an explicit credential reference is required');
  if (!ctx.get('credentials')) reject('credential resolver unavailable');
  return { ...structuredClone(route), revision: descriptor.revision, ns };
}

/** Validate the final serialized request before the SDK can send it. */
export function validateBoundedPayload(body, maxInputBytes = MAX_WIRE_BYTES) {
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > MAX_WIRE_BYTES) reject('invalid input byte bound');
  if (!body || body.model !== OPENROUTER_MODEL || body.stream !== true) reject('unexpected wire identity');
  const limit = body.max_completion_tokens ?? body.max_tokens;
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) reject('output bound must be 1–8 tokens');
  if (own(body, 'max_completion_tokens') && own(body, 'max_tokens')) reject('ambiguous output bounds');
  if (JSON.stringify(body.provider) !== JSON.stringify(ROUTING_CAPS)) reject('routing price caps missing');
  if (body.n !== undefined && body.n !== 1) reject('multiple completions forbidden');
  if (body.models || body.plugins || body.web_search_options) reject('extra billed operations forbidden');
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > maxInputBytes) reject('serialized request exceeds safe input budget');
}

/** Internal pure constructor, also used by loopback-only wire tests. */
export function buildBoundedAdapter({ catalogProvider, route, resolveApiKey, Adapter = PiAiAdapter, expectedBase = OPENROUTER_BASE, maxInputBytes = MAX_WIRE_BYTES }) {
  if (catalogProvider.id !== 'openrouter' || catalogProvider.baseUrl !== expectedBase) reject('unexpected catalog endpoint');
  const original = catalogProvider.getModels().find((model) => model.id === OPENROUTER_MODEL);
  if (!original || original.provider !== 'openrouter' || original.api !== 'openai-completions' || original.baseUrl !== expectedBase) reject('catalog model or endpoint mismatch');
  const model = { ...original, compat: { ...original.compat, openRouterRouting: ROUTING_CAPS } };
  const provider = {
    ...catalogProvider,
    getModels: () => [model],
    streamSimple: (selected, context, options) => catalogProvider.streamSimple(selected, context, {
      ...options,
      maxRetries: 0,
      onPayload: (payload) => { validateBoundedPayload(payload, maxInputBytes); },
    }),
  };
  const profile = {
    provider: 'openrouter',
    displayName: 'OpenRouter (bounded cache request)',
    cacheRetention: route.cacheRetention,
    reasoning: route.reasoning,
    transport: route.transport,
    timeoutMs: Math.min(route.timeoutMs ?? 30_000, 30_000),
    streamIdleTimeoutMs: Math.min(route.streamIdleTimeoutMs ?? 30_000, 30_000),
    configuredMaxTokens: new Map(), modelErrors: new Map(), piProvider: provider,
    retryPolicy: { mode: 'normal', maxRetries: 0 },
  };
  const profiles = new Map([['openrouter', profile]]);
  const adapter = new Adapter({
    profiles: () => profiles,
    resolveApiKey,
    auth: {
      credentials: { read: async () => undefined, list: async () => [], modify: async () => { reject('ambient auth forbidden'); }, delete: async () => {} },
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
  });
  return {
    async *stream(options) {
      if (options.provider !== 'openrouter' || options.model !== OPENROUTER_MODEL) reject('unsupported route/model');
      if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 8) reject('output bound must be 1–8 tokens');
      // This capability never resolves attachments or runs returned tool calls.
      // Reject images/files before credentials are requested.
      const blocks = [...(options.messages ?? [])].flatMap((message) => message.content ?? []);
      if (blocks.some((block) => block.type === 'image' || block.type === 'file')) reject('only serialized text context is supported');
      const deadline = AbortSignal.timeout(30_000);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      yield* adapter.stream({ ...options, signal });
    },
  };
}

/** Create a scoped capability, without exposing authentication to its caller. */
export async function createBoundedOpenRouter(ctx, { maxInputBytes = MAX_WIRE_BYTES } = {}) {
  const route = readOpenRouterRoute(ctx);
  const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve(PACKAGE));
  const { openrouterProvider } = await import(new URL('./dist/providers/openrouter.js', pathToFileURL(manifest)).href);
  const identity = JSON.stringify(route);
  return buildBoundedAdapter({
    catalogProvider: openrouterProvider(), route, maxInputBytes,
    resolveApiKey: async () => {
      if (JSON.stringify(readOpenRouterRoute(ctx)) !== identity) reject('route changed; recreate capability');
      const resolved = await ctx.get('credentials').resolve(credentialRef(route.apiKeyEnv));
      if (!resolved?.value) reject('configured credential is unavailable');
      return resolved.value;
    },
  });
}
