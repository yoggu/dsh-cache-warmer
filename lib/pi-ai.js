import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { createRequire, findPackageJSON } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, dirname, resolve } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const PACKAGE = '@deepseek-ai/dsh-llm-pi-ai';
const REVIEWED_ADAPTER = '0.2.0-rc.2';
const REVIEWED_NATIVE = '0.99.1';
export const MAX_INPUT_BYTES = 1_048_576;
export const OUTPUT_RESERVE = 256;
export const KEEPALIVE = 'Cache refresh only. Reply with exactly: OK. Do not call tools.';
const DEADLINE_MS = 10_000;
const ids = new WeakMap();
let nextId = 0;
const identityKey = randomBytes(32);
const objectId = value => {
  if (!value || !['object', 'function'].includes(typeof value)) return String(value);
  if (!ids.has(value)) ids.set(value, ++nextId);
  return ids.get(value);
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function reject(reasonCode = 'unsupported-capability') {
  throw Object.assign(new Error(`Native cache refresh unavailable (${reasonCode}).`), { reasonCode });
}
// Values never leave this module: the keyed digest detects in-place edits without
// disclosing endpoints, headers, credential references, or low-entropy secrets.
function digest(value) {
  const seen = new WeakSet();
  return createHmac('sha256', identityKey).update(JSON.stringify(value, (_key, member) => {
    if (typeof member === 'function') return { functionId: objectId(member) };
    if (member && typeof member === 'object') {
      if (seen.has(member)) return { referenceId: objectId(member) };
      seen.add(member);
      if (member instanceof Map) return { entries: [...member] };
    }
    return member;
  })).digest('hex');
}
const owners = [];
function addOwner(entry, Adapter) {
  try {
    const adapterManifest = findPackageJSON(PACKAGE, entry);
    const nativeManifest = findPackageJSON('@earendil-works/pi-ai', entry);
    if (!adapterManifest || !nativeManifest) return;
    const adapterVersion = JSON.parse(readFileSync(adapterManifest, 'utf8')).version;
    const nativeVersion = JSON.parse(readFileSync(nativeManifest, 'utf8')).version;
    if (typeof Adapter !== 'function' || owners.some(owner => owner.Adapter === Adapter)) return;
    owners.push({ Adapter, entry, adapterVersion, nativeVersion, nativeManifest });
  } catch { /* Missing/unknown peers are not trusted by structural resemblance. */ }
}
addOwner(import.meta.resolve(PACKAGE), PiAiAdapter);
let lastAnchor;
function verifiedOwner(adapter) {
  // Linked plugins may load a different peer than the executable. Resolve the
  // public class from the running executable's real path, never a fixed DSH path.
  if (lastAnchor !== process.argv[1]) {
    lastAnchor = process.argv[1];
    if (typeof lastAnchor === 'string' && isAbsolute(lastAnchor)) {
      try {
        const require = createRequire(realpathSync(lastAnchor));
        const entry = require.resolve(PACKAGE);
        addOwner(entry, require(entry).PiAiAdapter);
      } catch { /* Embedded/unknown layouts fail closed. */ }
    }
  }
  return owners.find(owner => adapter instanceof owner.Adapter);
}
const APIS = new Set(['openai-completions', 'openai-responses', 'azure-openai-responses',
  'openai-codex-responses', 'anthropic-messages', 'google-generative-ai', 'google-vertex',
  'mistral-conversations', 'pi-messages']);
function isOpenRouter(model) {
  if (model.provider === 'openrouter') return true;
  try { return new URL(model.baseUrl).hostname === 'openrouter.ai'; } catch { return false; }
}
function routerAlias(model) {
  return ['auto', 'free', 'fusion'].includes(model) || model.startsWith('openrouter/') || /:online$/.test(model);
}
/** Pure calculation seam; production supplies only the reviewed owner's catalog cost. */
export function openRouterRoutingCaps(cost, longWrites = false) {
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const validRate = (rate, extra) => record(rate)
    && Object.keys(rate).every(key => keys.includes(key) || key === extra)
    && keys.every(key => nonnegative(rate[key]));
  if (!validRate(cost, 'tiers') || (cost.tiers !== undefined && !Array.isArray(cost.tiers))) return null;
  const tiers = cost.tiers ?? [];
  if (!tiers.every(tier => validRate(tier, 'inputTokensAbove') && nonnegative(tier.inputTokensAbove))) return null;
  const rates = [cost, ...tiers];
  // OpenRouter max_price uses USD / million tokens, like pi-ai's catalog.
  // Include every request-wide tier, cache rates, and 2x input for 1h writes.
  const prompt = Math.max(...rates.flatMap(rate => [rate.input, rate.cacheRead, rate.cacheWrite, longWrites ? 2 * rate.input : 0]));
  const completion = Math.max(...rates.map(rate => rate.output));
  if (!nonnegative(prompt) || !nonnegative(completion)) return null;
  return { require_parameters: true, allow_fallbacks: false, max_price: { prompt, completion, request: 0 } };
}
function routerRouting(route) {
  const model = route.descriptor;
  if (routerAlias(model.id)) reject('unsupported-model');
  // Only the reviewed Completions serializer carries OpenRouter's provider
  // object. Other native protocols must not silently lose routing protection.
  if (model.api !== 'openai-completions') reject('unsupported-protocol');
  const require = createRequire(route.owner.nativeManifest);
  const { getBuiltinModels } = require(resolve(dirname(route.owner.nativeManifest), 'dist/providers/all.js'));
  const base = getBuiltinModels('openrouter').find(value => value.id === model.id);
  if (!base || base.api !== model.api || !isDeepStrictEqual(base.cost, model.cost)
    || !isDeepStrictEqual(base.samplingParams, model.samplingParams)) reject('unknown-pricing');
  const longWrites = (model.compat?.cacheControlFormat === 'anthropic' || model.id.startsWith('anthropic/'))
    && route.profile.cacheRetention !== 'short' && route.profile.cacheRetention !== 'none';
  const caps = openRouterRoutingCaps(base.cost, longWrites);
  if (!caps) reject('unknown-pricing');
  const configured = model.compat?.openRouterRouting;
  if (configured !== undefined && !record(configured)) reject('unsupported-route');
  return { ...structuredClone(configured ?? {}), ...caps };
}
function capture(ctx, provider, model) {
  const adapter = ctx?.llm?.adapters?.get(provider)?.adapter;
  const owner = adapter && verifiedOwner(adapter);
  if (!owner) return { owned: false, reasonCode: 'not-pi-ai' };
  const route = { owned: true, owner, adapter };
  if (owner.adapterVersion !== REVIEWED_ADAPTER || owner.nativeVersion !== REVIEWED_NATIVE)
    return { ...route, reasonCode: 'unsupported-version' };
  try {
    if (typeof adapter.current !== 'function' || typeof adapter.profileOf !== 'function'
      || typeof adapter.modelOf !== 'function' || typeof adapter.config?.resolveApiKey !== 'function')
      return { ...route, reasonCode: 'unsupported-capability' };
    const snapshot = adapter.current();
    const profile = adapter.profileOf(snapshot, provider);
    const descriptor = adapter.modelOf(snapshot, provider, model);
    const nativeProvider = snapshot.models.getProvider(provider);
    const resolved = { ...route, snapshot, profile, descriptor, nativeProvider };
    if (!nativeProvider || nativeProvider !== profile.piProvider || nativeProvider.id !== provider
      || typeof nativeProvider.streamSimple !== 'function' || descriptor.provider !== provider
      || descriptor.id !== model) return { ...resolved, reasonCode: 'unsupported-route' };
    // Custom chat entries from this adapter omit type; pi-ai defines absence as chat.
    if (descriptor.type !== undefined && descriptor.type !== 'chat')
      return { ...resolved, reasonCode: 'unsupported-model' };
    if (!descriptor.input?.includes('text')) return { ...resolved, reasonCode: 'unsupported-model' };
    // AWS's native client ignores maxRetries and has its own default retry loop.
    if (descriptor.api === 'bedrock-converse-stream')
      return { ...resolved, reasonCode: 'unsupported-no-retry' };
    if (!APIS.has(descriptor.api)) return { ...resolved, reasonCode: 'unsupported-protocol' };
    if (!Number.isInteger(descriptor.maxTokens) || descriptor.maxTokens < 1
      || !Number.isInteger(descriptor.contextWindow) || descriptor.contextWindow < 1)
      return { ...resolved, reasonCode: 'unsupported-capability' };
    if (descriptor.compat?.allowedFallbackModels?.length)
      return { ...resolved, reasonCode: 'unsupported-fallbacks' };
    if (isOpenRouter(descriptor)) {
      try { resolved.routingCaps = routerRouting(resolved); }
      catch (error) { return { ...resolved, reasonCode: error.reasonCode ?? 'unsupported-route' }; }
    }
    resolved.auth = adapter.config.auth;
    resolved.resolveApiKey = adapter.config.resolveApiKey;
    resolved.fingerprint = `pi-ai:${objectId(adapter)}:${objectId(snapshot)}:${digest([
      provider, model, profile, descriptor, objectId(nativeProvider), objectId(resolved.auth),
      objectId(resolved.resolveApiKey), owner.adapterVersion, owner.nativeVersion,
    ])}`;
    return resolved;
  } catch { return { ...route, reasonCode: 'unsupported-model' }; }
}
function outputBound(route) {
  // Synchronous inspection must not resolve credentials. Native Responses auth
  // can replace baseUrl, and ChatGPT sign-in omits max_output_tokens. Report a
  // client-only bound for ALL Responses, even when an API-key request has a cap.
  return ['openai-codex-responses', 'openai-responses'].includes(route.descriptor?.api) ? 'client' : 'server';
}
function requestSupport(route, options) {
  if (route.reasonCode) return route.reasonCode;
  const effort = options?.reasoningEffort ?? route.profile.reasoning;
  const efforts = route.adapter.modelInfo(route.snapshot, route.descriptor.provider, route.descriptor.id).reasoning?.efforts?.map(value => String(value.id)) ?? ['off'];
  if (effort !== undefined && !efforts.includes(effort)) return 'unsupported-reasoning';
  // Changing thinking mode/budget alters Anthropic cache identity. Do not switch
  // it off just to fit the cap. Fixed native thinking requires >=1024 tokens.
  if (route.descriptor.api === 'anthropic-messages' && effort !== undefined && effort !== 'off'
    && route.descriptor.compat?.forceAdaptiveThinking !== true
    && route.descriptor.compat?.supportsMidConvoEffort !== true) return 'unsafe-thinking-budget';
  return null;
}
/** Credential-free synchronous admission. This does not enable/schedule requests. */
export function piAiRouteInfo(ctx, provider, model, capturedOptions) {
  try {
    const route = capture(ctx, provider, model);
    const reasonCode = route.owned ? requestSupport(route, capturedOptions) : route.reasonCode;
    return { owned: route.owned, supported: route.owned && !reasonCode,
      reasonCode: reasonCode ?? null, retention: ['none', 'short', 'long'].includes(route.profile?.cacheRetention) ? route.profile.cacheRetention : 'unknown',
      kind: 'pi-ai', maxOutputTokens: 256, outputReserve: OUTPUT_RESERVE,
      fingerprint: route.fingerprint ?? null, outputBound: outputBound(route),
      ...(outputBound(route) === 'client' ? { reason: 'Best-effort client cancellation only; 256 tokens is a planning reserve, not a server output or billing guarantee.' } : {}) };
  } catch {
    return { owned: false, supported: false, reasonCode: 'not-pi-ai', retention: 'unknown',
      kind: 'pi-ai', maxOutputTokens: 256, outputReserve: OUTPUT_RESERVE, fingerprint: null, outputBound: 'client' };
  }
}
/** Exact active owner's cost implementation, with bundled-catalog provenance. */
export function piAiPricing(ctx, provider, model) {
  try {
    const route = capture(ctx, provider, model);
    if (!route.owned || route.reasonCode) return null;
    const require = createRequire(route.owner.nativeManifest);
    const root = dirname(route.owner.nativeManifest);
    const { getBuiltinModels } = require(resolve(root, 'dist/providers/all.js'));
    const base = getBuiltinModels(provider).find(value => value.id === model);
    // Hand-declared uncatalogued models get synthetic NO_COST, not free pricing.
    if (!base || base.api !== route.descriptor.api || base.baseUrl !== route.descriptor.baseUrl
      || !isDeepStrictEqual(base.cost, route.descriptor.cost)
      || !isDeepStrictEqual(base.samplingParams, route.descriptor.samplingParams)
      || ['openRouterRouting', 'vercelGatewayRouting'].some(key =>
        !isDeepStrictEqual(base.compat?.[key], route.descriptor.compat?.[key]))) return null;
    const cost = structuredClone(base.cost);
    const rates = [cost, ...(cost.tiers ?? [])];
    if (!rates.every(rate => ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => nonnegative(rate[key])))
      || (cost.tiers ?? []).some(tier => !nonnegative(tier.inputTokensAbove))) return null;
    const { calculateCost } = require(resolve(root, 'dist/models.js'));
    if (typeof calculateCost !== 'function') return null;
    // No headers/baseUrl/auth/credential refs escape through pricing.model.
    const anthropicCache = route.descriptor.api === 'anthropic-messages' || route.descriptor.compat?.cacheControlFormat === 'anthropic';
    const retention = route.profile.cacheRetention;
    return { model: { id: model, provider, cost }, calculateCost, fingerprint: route.fingerprint,
      cacheWrite1h: anthropicCache && retention !== 'short' && retention !== 'none',
      source: { owner: PACKAGE, catalog: provider, version: REVIEWED_NATIVE } };
  } catch { return null; }
}
function assertRoute(ctx, provider, model, expected) {
  const current = capture(ctx, provider, model);
  if (current.reasonCode || current.fingerprint !== expected.fingerprint) reject('route-changed');
}
function validateInput(options) {
  if (!Array.isArray(options.messages) || (options.system !== undefined && typeof options.system !== 'string')) reject('unsupported-content');
  for (const message of options.messages) {
    if (!['system', 'user', 'assistant', 'tool'].includes(message?.role)
      || !Array.isArray(message.content) || message.content.some(block =>
        !(message.role === 'assistant' ? ['text', 'reasoning', 'tool-call'] : ['text']).includes(block?.type))) reject('unsupported-content');
    if (message.content.some(block => (block.type === 'text' || block.type === 'reasoning') && typeof block.text !== 'string')) reject('unsupported-content');
  }
  if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.some(tool =>
    !record(tool) || tool.deferLoading === true || typeof tool.name !== 'string' || !record(tool.parameters)))) reject('unsupported-tools');
  if (Buffer.byteLength(JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools, toolHistory: options.toolHistory }), 'utf8') > MAX_INPUT_BYTES) reject('input-too-large');
}
const KEYS = {
  'openai-completions': 'model stream messages tools tool_choice temperature store stream_options max_tokens max_completion_tokens reasoning reasoning_effort thinking enable_thinking chat_template_kwargs chat_template_args thinking_token_budget thinking_budget thinking_budget_tokens prompt_cache_key prompt_cache_retention provider n priority tool_stream',
  'openai-responses': 'model stream input tools tool_choice temperature store max_output_tokens prompt_cache_key prompt_cache_retention prompt_cache_options reasoning include',
  'azure-openai-responses': 'model stream input tools tool_choice temperature store max_output_tokens prompt_cache_key prompt_cache_retention reasoning include',
  'openai-codex-responses': 'model stream input tools tool_choice temperature store instructions text include prompt_cache_key parallel_tool_calls reasoning',
  'anthropic-messages': 'model stream messages max_tokens system tools tool_choice temperature betas thinking output_config metadata',
  'google-generative-ai': 'model contents config',
  'google-vertex': 'model contents config',
  'mistral-conversations': 'model stream messages tools temperature maxTokens toolChoice promptMode reasoningEffort promptCacheKey',
  'pi-messages': 'model context options',
};
function onlyKeys(value, allowed) {
  if (!record(value) || Object.keys(value).some(key => value[key] !== undefined && !allowed.split(' ').includes(key))) reject('unsupported-payload');
}
function cap(value, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum || value > 256) reject('unsafe-output-bound');
}
function functionsOnly(tools, protocol) {
  if (tools === undefined) return;
  if (!Array.isArray(tools) || tools.some(tool => !record(tool))) reject('unsupported-tools');
  for (const tool of tools) {
    if (protocol === 'anthropic-messages') {
      onlyKeys(tool, 'name description input_schema cache_control strict eager_input_streaming');
      if (!record(tool.input_schema) || typeof tool.name !== 'string') reject('unsupported-tools');
    } else if (tool.type !== 'function') reject('unsupported-tools');
  }
}
function textBlocks(content, allowed, nestedToolResults = false) {
  if (content === undefined || content === null || typeof content === 'string') return;
  if (!Array.isArray(content)) reject('unsupported-content');
  for (const block of content) {
    if (!record(block) || !allowed.includes(block.type)) reject('unsupported-content');
    if (nestedToolResults && block.type === 'tool_result') textBlocks(block.content, ['text']);
  }
}
function guardHistory(body, api) {
  if (['openai-completions', 'mistral-conversations'].includes(api)) {
    if (!Array.isArray(body.messages)) reject('unsupported-content');
    for (const message of body.messages) {
      textBlocks(message.content, ['text']);
      if (message.tool_calls?.some(tool => tool.type !== 'function')) reject('unsupported-tools');
    }
  } else if (api.includes('responses')) {
    if (!Array.isArray(body.input)) reject('unsupported-content');
    for (const item of body.input) {
      if (item.type !== undefined && !['message', 'function_call', 'function_call_output', 'reasoning'].includes(item.type)) reject('unsupported-content');
      textBlocks(item.content, ['input_text', 'output_text']);
    }
  } else if (api === 'anthropic-messages') {
    if (!Array.isArray(body.messages)) reject('unsupported-content');
    textBlocks(body.system, ['text']);
    for (const message of body.messages) textBlocks(message.content, ['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result'], true);
  } else if (api.startsWith('google-')) {
    if (!Array.isArray(body.contents)) reject('unsupported-content');
    for (const content of body.contents) {
      if (!Array.isArray(content.parts)) reject('unsupported-content');
      for (const part of content.parts) onlyKeys(part, 'text thought thoughtSignature functionCall functionResponse');
    }
  }
}
function wireModelId(owner, model, options) {
  if (model.api !== 'azure-openai-responses') return model.id;
  // Preserve the native, auth-scoped Azure deployment map, which maps catalog
  // model identities to deployment names rather than selecting another model.
  const require = createRequire(owner.nativeManifest);
  const { getProviderEnvValue } = require(resolve(dirname(owner.nativeManifest), 'dist/utils/provider-env.js'));
  const value = getProviderEnvValue('AZURE_OPENAI_DEPLOYMENT_NAME_MAP', options.env);
  const mapping = new Map();
  for (const entry of (value ?? '').split(',')) {
    const [id, deployment] = entry.trim().split('=', 2);
    if (id && deployment) mapping.set(id.trim(), deployment.trim());
  }
  return mapping.get(model.id) || model.id;
}
function guardPayload(body, model, signal, expectedModel = model.id, routingCaps) {
  const api = model.api;
  onlyKeys(body, KEYS[api]);
  if (body.model !== expectedModel) reject('route-changed');
  if ((routingCaps || isOpenRouter(model)) && (api !== 'openai-completions' || !routingCaps
    || !isDeepStrictEqual(body.provider, routingCaps))) reject('unsafe-routing');
  guardHistory(body, api);
  if (['openai-completions', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses', 'anthropic-messages', 'mistral-conversations'].includes(api)
    && body.stream !== true) reject('unsupported-payload');
  if (api === 'openai-completions') {
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) reject('unsafe-output-bound');
    cap(body.max_completion_tokens ?? body.max_tokens);
    if (body.n !== undefined && body.n !== 1) reject('unsupported-payload');
    functionsOnly(body.tools, api);
  } else if (api === 'openai-responses') {
    if (body.max_output_tokens !== undefined) cap(body.max_output_tokens, 16);
    functionsOnly(body.tools, api);
  } else if (api === 'azure-openai-responses') {
    cap(body.max_output_tokens, 16);
    functionsOnly(body.tools, api);
  } else if (api === 'openai-codex-responses') {
    // The Codex backend rejects max_output_tokens. Never inject it.
    functionsOnly(body.tools, api);
  } else if (api === 'anthropic-messages') {
    cap(body.max_tokens);
    functionsOnly(body.tools, api);
    if (body.thinking?.type === 'enabled' && (!Number.isInteger(body.thinking.budget_tokens)
      || body.thinking.budget_tokens < 1024 || body.thinking.budget_tokens >= body.max_tokens)) reject('unsafe-thinking-budget');
  } else if (api.startsWith('google-')) {
    onlyKeys(body.config, 'maxOutputTokens temperature systemInstruction tools toolConfig thinkingConfig abortSignal');
    cap(body.config.maxOutputTokens);
    if (body.config.abortSignal !== signal || signal.aborted) reject('aborted');
    if (body.config.tools?.some(tool => !record(tool) || Object.keys(tool).some(key => key !== 'functionDeclarations'))) reject('unsupported-tools');
    const thinking = body.config.thinkingConfig;
    if (thinking?.thinkingBudget !== undefined && (thinking.thinkingBudget < 0 || thinking.thinkingBudget > 256)) reject('unsafe-thinking-budget');
  } else if (api === 'mistral-conversations') {
    cap(body.maxTokens);
    functionsOnly(body.tools, api);
  } else if (api === 'pi-messages') {
    onlyKeys(body.options, 'temperature maxTokens reasoning cacheRetention sessionId toolChoice');
    cap(body.options.maxTokens);
  }
  // Only a control AbortSignal is excluded. Everything billed/on the wire is
  // bounded, including history, replay, schema overhead and the appended suffix.
  const json = JSON.stringify(body, (key, value) => api.startsWith('google-') && key === 'abortSignal' ? undefined : value);
  if (Buffer.byteLength(json, 'utf8') > MAX_INPUT_BYTES) reject('input-too-large');
}
function abortRace(promise, signal) {
  return new Promise((resolve, rejectPromise) => {
    const aborted = () => rejectPromise(Object.assign(new Error('Native cache refresh aborted.'), { reasonCode: 'aborted' }));
    if (signal.aborted) { void Promise.resolve(promise).catch(() => {}); aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, rejectPromise).finally(() => signal.removeEventListener('abort', aborted));
  });
}
/** Called ONLY by the parent's scheduled, user-consented policy path. */
export async function createPiAiTransport(ctx, { provider, model, options: capturedOptions } = {}) {
  let route;
  try { route = capture(ctx, provider, model); } catch { reject('unsupported-capability'); }
  if (!route.owned || route.reasonCode) reject(route.reasonCode ?? 'not-pi-ai');
  const reasonCode = requestSupport(route, capturedOptions);
  if (reasonCode) reject(reasonCode);
  return { async *stream(options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    timer.unref?.();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let iterator;
    let pendingUsage;
    let count = 0, chars = 0;
    try {
      if (options.provider !== provider || options.model !== model) reject('route-changed');
      validateInput(options);
      const unsupported = requestSupport(route, options);
      if (unsupported) reject(unsupported);
      assertRoute(ctx, provider, model, route);
      signal.throwIfAborted();
      const descriptor = structuredClone(route.descriptor);
      // Add routing controls only to our isolated descriptor. The live native
      // model, genuine replay, thinking settings and captured prefix stay intact.
      if (route.routingCaps) descriptor.compat = { ...descriptor.compat, openRouterRouting: structuredClone(route.routingCaps) };
      const nativeProvider = route.nativeProvider;
      const wrapped = { ...nativeProvider, getModels: () => [descriptor],
        streamSimple(selected, context, nativeOptions) {
          assertRoute(ctx, provider, model, route);
          signal.throwIfAborted();
          // Models.applyAuth owns endpoint replacement (e.g. Copilot). All other
          // descriptor fields must still match the captured exact selected model.
          if (!isDeepStrictEqual({ ...selected, baseUrl: descriptor.baseUrl }, descriptor)) reject('route-changed');
          // Auth may replace the endpoint. A foreign route cannot become an
          // unguarded OpenRouter request after synchronous admission.
          if (isOpenRouter(selected) && !route.routingCaps) reject('unsafe-routing');
          const wireIdentity = wireModelId(route.owner, selected, nativeOptions);
          const serializerOptions = { ...nativeOptions, maxTokens: 256, maxRetries: 0,
            timeoutMs: Math.min(nativeOptions.timeoutMs ?? DEADLINE_MS, DEADLINE_MS),
            ...(selected.api.includes('responses') ? { transport: 'sse' } : {}),
            onPayload(payload, payloadModel) {
              assertRoute(ctx, provider, model, route);
              signal.throwIfAborted();
              if (payloadModel && !isDeepStrictEqual(payloadModel, selected)) reject('route-changed');
              if (wireModelId(route.owner, selected, nativeOptions) !== wireIdentity) reject('route-changed');
              guardPayload(payload, selected, nativeOptions.signal, wireIdentity, route.routingCaps);
            } };
          return nativeProvider.streamSimple.call(nativeProvider, selected, context, serializerOptions);
        } };
      const { piProvider: _liveProvider, ...profileData } = route.profile;
      const profile = { ...structuredClone(profileData),
        piProvider: wrapped, timeoutMs: DEADLINE_MS, streamIdleTimeoutMs: DEADLINE_MS,
        retryPolicy: { mode: 'normal', maxRetries: 0 } };
      const profiles = new Map([[provider, profile]]);
      const isolated = new route.owner.Adapter({ profiles: () => profiles, auth: route.auth,
        resolveApiKey: async () => {
          assertRoute(ctx, provider, model, route);
          signal.throwIfAborted();
          const key = await route.resolveApiKey.call(route.adapter.config, provider, route.profile);
          assertRoute(ctx, provider, model, route);
          signal.throwIfAborted();
          return key;
        } });
      // Preserve genuine reasoning and native tool-choice controls: changing
      // either can invalidate cached messages. Returned tool calls abort; this
      // capability has no dispatcher and never executes a tool.
      const { signal: _callerSignal, ...plainOptions } = options;
      const generate = structuredClone(plainOptions);
      iterator = isolated.stream({ ...generate, provider, model,
        messages: [...generate.messages, { role: 'user', content: [{ type: 'text', text: KEEPALIVE }] }],
        maxTokens: 256, signal })[Symbol.asyncIterator]();
      while (true) {
        const result = await abortRace(iterator.next(), signal);
        if (result.done) break;
        const chunk = result.value;
        if (++count > 1024) { controller.abort(); break; }
        if (chunk.type.endsWith('delta')) chars += (chunk.text ?? chunk.argumentsDelta ?? '').length;
        if (chars > 1024 || chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call'
          || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
          controller.abort(); break;
        }
        if (chunk.type === 'usage') { pendingUsage = chunk; continue; }
        if (chunk.type === 'finish') {
          const failed = ['error', 'aborted'].includes(chunk.reason?.kind);
          if (pendingUsage && (!failed || Object.values(pendingUsage.usage).some(value => typeof value === 'number' && value > 0))) yield pendingUsage;
          yield failed ? { type: 'finish', reason: { kind: chunk.reason.kind,
            failure: { code: chunk.reason.kind === 'aborted' ? 'ABORTED' : 'PI_AI_ERROR', message: 'Native cache refresh did not complete.' } } } : chunk;
          return;
        }
        // Only normal native text/reasoning chunks escape; never SDK diagnostic
        // data, whose payload may contain provider errors or auth information.
        if (['block-start', 'text-delta', 'reasoning-delta', 'block-end'].includes(chunk.type)) yield chunk;
      }
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Native cache refresh stopped at its client bound.' } } };
    } catch (error) {
      if (signal.aborted) {
        if (pendingUsage && Object.values(pendingUsage.usage).some(value => typeof value === 'number' && value > 0)) yield pendingUsage;
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Native cache refresh stopped at its client bound.' } } };
      } else {
        // Never propagate SDK errors/cause/headers/token-containing body text.
        reject(['route-changed', 'unsupported-content', 'unsupported-tools', 'input-too-large', 'unsupported-reasoning', 'unsafe-thinking-budget'].includes(error?.reasonCode) ? error.reasonCode : 'unsupported-capability');
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Do not wait indefinitely for an SDK/auth teardown after our deadline.
      if (iterator?.return) void iterator.return().catch(() => {});
    }
  } };
}
