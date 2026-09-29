import { createRequire, findPackageJSON } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

// Legacy fixture exports only. Production admission and prices never use these.
export const OPENROUTER_MODEL = '~deepseek/deepseek-v4-flash-latest';
export const ROUTING_CAPS = Object.freeze({
  require_parameters: true,
  allow_fallbacks: false,
  max_price: Object.freeze({ prompt: 1, completion: 2, request: 0 }),
});
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
// Independent request-size ceiling, not a user-facing monetary budget.
export const MAX_WIRE_BYTES = 1_048_576;
const PACKAGE = '@deepseek-ai/dsh-llm-pi-ai';
// The bounded serializer/payload seam is reviewed against this exact pi-ai build.
// Older 0.85.x builds cannot reliably serialize all supported request shapes.
export const REVIEWED_PI_AI_VERSION = '0.99.1';
const REVIEWED_OPENROUTER_CATALOG_SHA256 = 'b49405ced089750d475945738a91ac669fa00e04d574da7720935bcfe16ba272';
export function requireReviewedPiAiVersion(manifest) {
  try {
    const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
    if (version === REVIEWED_PI_AI_VERSION) return;
  } catch { /* fail closed */ }
  reject('unreviewed pi-ai serializer version', 'unsupported-capability');
}
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyObject = (value) => record(value) && Object.keys(value).length === 0;
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function reject(reason, reasonCode = 'unsupported-capability') {
  throw Object.assign(new Error(`Bounded OpenRouter unavailable: ${reason}`), { reasonCode });
}

let installedProvider;
let installedPricing;
/** Return the reviewed serializer's model and cost function, rechecking source before each decision/send. */
export function reviewedOpenRouterPricing(modelId) {
  let support;
  try {
    const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve(PACKAGE));
    requireReviewedPiAiVersion(manifest);
    const catalogPath = fileURLToPath(new URL('./dist/providers/data/openrouter.json', pathToFileURL(manifest)));
    const digest = createHash('sha256').update(readFileSync(catalogPath)).digest('hex');
    if (digest !== REVIEWED_OPENROUTER_CATALOG_SHA256) return null;
    if (!installedPricing || installedPricing.manifest !== manifest) {
      const pi = createRequire(manifest);
      const { calculateCost } = pi(fileURLToPath(new URL('./dist/models.js', pathToFileURL(manifest))));
      if (typeof calculateCost !== 'function') return null;
      installedPricing = { calculateCost, manifest };
    }
    support = inspectModel(catalogProvider(), modelId);
  } catch { return null; }
  if (!support.supported || !support.model) return null;
  return Object.freeze({ model: support.model, calculateCost: installedPricing.calculateCost,
    source: Object.freeze({ owner: PACKAGE, catalog: 'openrouter', version: REVIEWED_PI_AI_VERSION,
      digest: REVIEWED_OPENROUTER_CATALOG_SHA256 }),
    fingerprint: `${REVIEWED_PI_AI_VERSION}:${REVIEWED_OPENROUTER_CATALOG_SHA256}` });
}
function catalogProvider() {
  if (installedProvider === undefined) {
    try {
      // Node >=22.19 can synchronously require this ESM provider (no top-level
      // await). It only constructs the bundled catalog and lazy serializers;
      // it does not resolve auth, refresh models or contact a provider. Using
      // the adapter's nested copy avoids a second, subtly different catalog.
      const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve(PACKAGE));
      requireReviewedPiAiVersion(manifest);
      const require = createRequire(manifest);
      const { openrouterProvider } = require(fileURLToPath(new URL('./dist/providers/openrouter.js', pathToFileURL(manifest))));
      installedProvider = openrouterProvider();
    } catch { installedProvider = null; }
  }
  return installedProvider;
}

// Only reviewed Chat Completions switches. Unknown/new serializers and payload
// injection knobs fail closed; do not apply the DeepSeek model's compat to others.
const COMPAT_KEYS = new Set([
  'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort',
  'supportsUsageInStreaming', 'supportsFinishReason', 'maxTokensField',
  'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages', 'thinkingFormat', 'supportsStrictMode',
  'supportsMidConvoSystemMessages', 'supportsMidConvoToolAdditions',
  'cacheControlFormat', 'sendSessionAffinityHeaders', 'sessionAffinityFormat',
  'supportsLongCacheRetention',
]);

function routingCapsFor(model) {
  const cost = model.cost;
  const rates = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const validRates = (value, extra) => record(value)
    && Object.keys(value).every((key) => rates.includes(key) || key === extra)
    && rates.every((key) => nonnegative(value[key]));
  if (!validRates(cost, 'tiers') || (cost.tiers !== undefined && !Array.isArray(cost.tiers))) return null;
  const tiers = cost.tiers ?? [];
  if (!tiers.every((tier) => validRates(tier, 'inputTokensAbove') && nonnegative(tier.inputTokensAbove))) return null;
  const all = [cost, ...tiers];
  // Catalog USD / million tokens, same units as OpenRouter max_price. Include
  // all request-wide tiers and cache rates, not the old arbitrary $1/$2 ceiling.
  // Anthropic-style long retention may charge 2x input for a cache write.
  const longWrite = model.compat?.cacheControlFormat === 'anthropic';
  const prompt = Math.max(...all.flatMap((rate) => [rate.input, rate.cacheRead, rate.cacheWrite, longWrite ? 2 * rate.input : 0]));
  const completion = Math.max(...all.map((rate) => rate.output));
  if (!nonnegative(prompt) || !nonnegative(completion)) return null;
  return Object.freeze({
    require_parameters: true, allow_fallbacks: false,
    max_price: Object.freeze({ prompt, completion, request: 0 }),
  });
}

function inspectModel(provider, modelId, expectedBase = OPENROUTER_BASE) {
  const no = (reasonCode) => ({ supported: false, reasonCode });
  if (typeof modelId !== 'string' || !modelId.length) return no('unsupported-model');
  if (!provider) return no('catalog-unavailable');
  if (provider.id !== 'openrouter' || provider.baseUrl !== expectedBase || !emptyObject(provider.headers ?? {})) return no('unsupported-route');
  if (typeof provider.getModels !== 'function' || typeof provider.streamSimple !== 'function') return no('unsupported-capability');
  const matches = provider.getModels().filter((model) => model.id === modelId);
  if (matches.length !== 1) return no('unsupported-model');
  const model = matches[0];
  // Router aliases select another model rather than bind a concrete model.
  if (modelId === 'auto' || modelId.startsWith('openrouter/') || /:online$/.test(modelId)) return no('unsupported-model');
  // Its native buildBaseOptions only clamps the caller's maxTokens DOWN;
  // native Anthropic can add a thinking budget and cannot use these route caps.
  if (model.type !== 'chat' || model.api !== 'openai-completions') return no('unsupported-protocol');
  if (model.provider !== 'openrouter' || model.baseUrl !== expectedBase) return no('unsupported-route');
  const compat = model.compat ?? {};
  if (!record(compat) || Object.keys(compat).some((key) => !COMPAT_KEYS.has(key))
    || (compat.thinkingFormat !== undefined && compat.thinkingFormat !== 'openrouter')
    || (compat.maxTokensField !== undefined && !['max_tokens', 'max_completion_tokens'].includes(compat.maxTokensField))
    || (compat.cacheControlFormat !== undefined && compat.cacheControlFormat !== 'anthropic')
    || compat.sendSessionAffinityHeaders === false
    || (compat.sessionAffinityFormat !== undefined && compat.sessionAffinityFormat !== 'openrouter')
    || !emptyObject(model.headers ?? {}) || !emptyObject(model.samplingParams ?? {})
    || !Array.isArray(model.input) || !model.input.includes('text')
    || !Number.isInteger(model.contextWindow) || model.contextWindow < 1
    || !Number.isInteger(model.maxTokens) || model.maxTokens < 8
    || typeof model.reasoning !== 'boolean') return no('unsupported-capability');
  const routingCaps = routingCapsFor(model);
  if (!routingCaps) return no('unknown-pricing');
  return { supported: true, reasonCode: null, model, routingCaps };
}

/** Synchronous, credential-free admission, shared by discovery and construction. */
export function openRouterModelSupport(model) {
  try {
    const { supported, reasonCode } = inspectModel(catalogProvider(), model);
    return { supported, reasonCode };
  } catch { return { supported: false, reasonCode: 'catalog-unavailable' }; }
}

/**
 * Inspect only the exact active route; never return config values or credentials.
 * @param ctx - the plugin's Cordis context.
 * @param cached - optional per-pass memo for the registry and settings reads.
 */
export function readOpenRouterRoute(ctx, cached = (key, read) => read()) {
  const entries = cached('configEditor', () => ctx.get('configEditor')?.entries() ?? []);
  const owners = entries.filter((entry) => entry.options?.name === PACKAGE && entry.fiber?.state === 2);
  if (owners.length !== 1) reject('requires exactly one active pi-ai configuration', 'unsupported-route');
  const owner = owners[0];
  const ns = owner.options.id;
  const settings = cached('settings', () => ctx.get('settings')?.describe({ redactSecrets: true }));
  const descriptor = settings?.find((item) => item.ns === ns);
  // Volatile providers must come from the current settings projection. Refuse
  // to guess from an inherited raw profile if that projection is unavailable.
  if (!descriptor || !record(descriptor.value)) reject('live provider settings unavailable', 'unsupported-route');
  const configured = descriptor.value.providers?.openrouter;
  if (!record(configured)) reject('openrouter route is not configured', 'unsupported-route');
  const route = structuredClone(configured);
  // Verified pi-ai Config materializations, not permission to accept overrides.
  if (Array.isArray(route.models) && route.models.length === 0) delete route.models;
  for (const key of ['modelOverrides', 'headers', 'thinkingBudgets']) if (emptyObject(route[key])) delete route[key];
  if (record(route.compat)) {
    for (const key of ['chatTemplateKwargs', 'chatTemplateArgs']) if (emptyObject(route.compat[key])) delete route.compat[key];
    if (emptyObject(route.compat)) delete route.compat;
  }
  if (route.defaultContextWindow === 262144) delete route.defaultContextWindow;
  if (route.defaultMaxTokens === 32768) delete route.defaultMaxTokens;
  if (Array.isArray(route.defaultInput) && route.defaultInput.length === 1 && route.defaultInput[0] === 'text') delete route.defaultInput;
  const allowed = new Set(['apiKeyEnv', 'displayName', 'cacheRetention', 'reasoning', 'transport', 'timeoutMs', 'websocketConnectTimeoutMs', 'streamIdleTimeoutMs', 'retryPolicy', 'requestImagePixelBudget', 'requestImageMaxBytes', 'maxRequestImageBytes']);
  if (Object.keys(route).some((key) => !allowed.has(key))) reject('custom endpoint, models, headers, protocol or unknown route controls', 'unsupported-route');
  if (typeof route.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(route.apiKeyEnv)) reject('an explicit credential reference is required', 'unsupported-route');
  if (!ctx.get('credentials')) reject('credential resolver unavailable', 'unsupported-route');
  return { ...structuredClone(route), revision: descriptor.revision, ns };
}

function validateByteBound(maxInputBytes) {
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > MAX_WIRE_BYTES) reject('invalid input byte bound');
}
const PAYLOAD_KEYS = new Set([
  'model', 'stream', 'messages', 'tools', 'tool_choice', 'temperature', 'store',
  'stream_options', 'max_tokens', 'max_completion_tokens', 'provider', 'n',
  'reasoning', 'prompt_cache_key', 'prompt_cache_retention',
]);

/** Validate the final native serialization before the SDK can send it. */
export function validateBoundedPayload(body, { modelId, routingCaps, maxInputBytes = MAX_WIRE_BYTES } = {}) {
  validateByteBound(maxInputBytes);
  if (typeof modelId !== 'string' || !modelId || !record(body) || body.model !== modelId || body.stream !== true) reject('unexpected wire identity');
  const limit = body.max_completion_tokens ?? body.max_tokens;
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) reject('output bound must be 1–8 tokens');
  if (own(body, 'max_completion_tokens') && own(body, 'max_tokens')) reject('ambiguous output bounds');
  if (!routingCaps || !isDeepStrictEqual(body.provider, routingCaps)
    || routingCaps.require_parameters !== true || routingCaps.allow_fallbacks !== false
    || routingCaps.max_price?.request !== 0
    || !nonnegative(routingCaps.max_price?.prompt) || !nonnegative(routingCaps.max_price?.completion)) reject('routing price caps missing');
  if (body.n !== undefined && body.n !== 1) reject('multiple completions forbidden');
  // Fail closed on serializer additions: modalities, search, plugins, alternate
  // models and sampling injection can carry separately billed operations.
  if (Object.keys(body).some((key) => !PAYLOAD_KEYS.has(key))) reject('extra billed operations or unsupported serialization forbidden');
  if (body.reasoning !== undefined && (!record(body.reasoning)
    || Object.keys(body.reasoning).some((key) => key !== 'effort') || typeof body.reasoning.effort !== 'string')) reject('unsupported reasoning serialization');
  if (!Array.isArray(body.messages) || body.messages.some((message) => !record(message)
    || (message.content != null && typeof message.content !== 'string'
      && (!Array.isArray(message.content) || message.content.some((block) => block?.type !== 'text'))))) reject('only serialized text context is supported');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) => tool?.type !== 'function'))) reject('unsupported tool serialization');
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > maxInputBytes) reject('serialized request exceeds safe input budget');
}

/** Internal constructor; expectedBase/Adapter injection is for offline tests only. */
export function buildBoundedAdapter({ modelId, catalogProvider, route, resolveApiKey, Adapter = PiAiAdapter, expectedBase = OPENROUTER_BASE, maxInputBytes = MAX_WIRE_BYTES, assertRoute = () => {} }) {
  validateByteBound(maxInputBytes);
  const support = inspectModel(catalogProvider, modelId, expectedBase);
  if (!support.supported) reject(support.reasonCode, support.reasonCode);
  const { routingCaps } = support;
  const model = structuredClone(support.model);
  model.compat = { ...model.compat, openRouterRouting: routingCaps };
  const provider = {
    ...catalogProvider,
    getModels: () => [model],
    streamSimple: (selected, context, options) => {
      if (selected.id !== modelId || selected.provider !== 'openrouter' || selected.api !== 'openai-completions' || selected.baseUrl !== expectedBase) reject('unexpected serializer identity');
      assertRoute();
      return catalogProvider.streamSimple(selected, context, {
        ...options,
        maxRetries: 0,
        onPayload: (payload) => {
          assertRoute();
          validateBoundedPayload(payload, { modelId, routingCaps, maxInputBytes });
        },
      });
    },
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
      if (options.provider !== 'openrouter' || options.model !== modelId) reject('unsupported route/model');
      if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 8) reject('output bound must be 1–8 tokens');
      // This capability never resolves attachments or runs returned tool calls.
      // Preserve text, reasoning, replay and tool history through PiAiAdapter.
      // The installed adapter explicitly rejects developer/tool-change history.
      // Reject it here too, before resolving any credential. Tool results are
      // tool-role messages with text content, not a separate nested block type.
      if (!Array.isArray(options.messages) || options.messages.some((message) =>
        !['system', 'user', 'assistant', 'tool'].includes(message.role)
        || !Array.isArray(message.content) || message.content.some((block) =>
          !(message.role === 'assistant' ? ['text', 'reasoning', 'tool-call'] : ['text']).includes(block?.type)))) reject('only serialized text context is supported');
      if (options.tools?.some((tool) => tool.deferLoading === true)) reject('unsupported deferred tool serialization');
      assertRoute();
      const deadline = AbortSignal.timeout(30_000);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      yield* adapter.stream({ ...options, signal });
    },
  };
}

/** Create a capability bound to a REQUIRED exact selected model, never a fallback. */
export async function createBoundedOpenRouter(ctx, { model, maxInputBytes = MAX_WIRE_BYTES } = {}) {
  const support = openRouterModelSupport(model);
  if (!support.supported) reject(support.reasonCode, support.reasonCode);
  const route = readOpenRouterRoute(ctx);
  const identity = JSON.stringify(route);
  const assertRoute = () => {
    if (JSON.stringify(readOpenRouterRoute(ctx)) !== identity) reject('route changed; recreate capability', 'unsupported-route');
  };
  return buildBoundedAdapter({
    modelId: model, catalogProvider: catalogProvider(), route, maxInputBytes, assertRoute,
    resolveApiKey: async () => {
      assertRoute();
      const resolved = await ctx.get('credentials').resolve(credentialRef(route.apiKeyEnv));
      assertRoute();
      if (!resolved?.value) reject('configured credential is unavailable');
      return resolved.value;
    },
  });
}
