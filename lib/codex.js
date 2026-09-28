import { createHash } from 'node:crypto';

const ACCOUNT_PLUGIN = 'dsh-codex-account';
const PROVIDERS = new Set(['codex-personal', 'codex-business']);
const ownerIds = new WeakMap();
let nextOwnerId = 0;

export const CODEX_WARM_PROMPT = 'Reply only OK. Do not use tools.';
// Pricing heuristic only. The Codex subscription API does NOT enforce maxTokens.
export const CODEX_WARM_OUTPUT_RESERVATION = 1024;

function unavailable(reason) { throw new Error(`Codex warming unavailable: ${reason}`); }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Synchronous route availability, never authentication status or credential data.
 * These aliases belong to dsh-codex-account, NOT the Harness pi-ai adapter.
 * A revision/owner fingerprint lets the caller invalidate a captured prefix when
 * its route/account/config changes. A configured route need not be signed in.
 */
export function readCodexRoute(ctx, provider, model, { allowDisabled = false, cached = (key, read) => read() } = {}) {
  if (!PROVIDERS.has(provider)) unavailable('unsupported provider');
  if (model !== undefined && (typeof model !== 'string' || !model)) unavailable('invalid model');
  const entries = cached('configEditor', () => ctx.get('configEditor')?.entries() ?? []);
  const owners = entries.filter(entry => entry.options?.name === ACCOUNT_PLUGIN && entry.fiber?.state === 2);
  if (owners.length !== 1) unavailable('requires one active Codex account plugin');
  const owner = owners[0];
  const ns = owner.options.id;
  // Codex account fields are NONVOLATILE: settings.describe() intentionally
  // omits this plugin. The documented Fiber.config is the validated, applied
  // configuration, unlike options.config's raw, possibly inherited expression.
  // Read only reviewed configuration fields; never enumerate unknown properties
  // or touch AccountStore/credential services during availability inspection.
  const applied = owner.fiber.config;
  if (!record(applied) || !Array.isArray(applied.accounts)) unavailable('live account config unavailable');
  const config = {};
  for (const key of ['storePath', 'transport', 'cacheRetention', 'streamIdleTimeoutMs',
    'readImages', 'requestImagePixelBudget', 'requestImageMaxBytes', 'maxRequestImageBytes',
    'models', 'defaultEfforts']) if (applied[key] !== undefined) config[key] = applied[key];
  config.accounts = applied.accounts.map(account => record(account)
    ? { id: account.id, provider: account.provider } : null);
  const accounts = config.accounts.filter(account => record(account) && account.provider === provider);
  if (accounts.length !== 1 || typeof accounts[0].id !== 'string' || !accounts[0].id) unavailable('account route is ambiguous or absent');
  const registered = cached('registeredRoutes', () => ctx.get('llm')?.listProviders());
  if (!registered?.some(item => item.id === provider)) unavailable('account route is not registered');
  const transport = config.transport ?? 'sse';
  const cacheRetention = config.cacheRetention ?? 'long';
  if (!['sse', 'websocket', 'websocket-cached', 'auto'].includes(transport)) unavailable('unknown transport');
  if (!['short', 'long'].includes(cacheRetention) && !(allowDisabled && cacheRetention === 'none')) unavailable('prompt caching is disabled');
  if (config.models !== undefined && (!Array.isArray(config.models) || config.models.some(value => typeof value !== 'string'))) unavailable('invalid model filter');
  if (model && config.models?.length && !config.models.includes(model)) unavailable('model is excluded from this route');
  if (!ownerIds.has(owner.fiber)) ownerIds.set(owner.fiber, ++nextOwnerId);
  // Hash reviewed live settings, including store selection, without exposing
  // paths. uid changes when the same Fiber is restarted; object identity catches
  // replacement as well. AccountStore itself stays inside its owner.
  const revision = owner.fiber.uid;
  const identity = createHash('sha256').update(JSON.stringify({
    ns, owner: ownerIds.get(owner.fiber), revision, provider, config,
  })).digest('hex');
  return Object.freeze({ provider, ...(model ? { model } : {}), accountId: accounts[0].id,
    ns, revision, transport, cacheRetention, identity });
}

const callConfig = options => {
  const config = { provider: options.provider, model: options.model };
  for (const key of ['reasoningEffort', 'temperature', 'maxTokens', 'stop']) {
    if (options[key] !== undefined) config[key] = options[key];
  }
  return config;
};

function terminal(reason) {
  if (!reason || !['stop', 'max-tokens', 'tool-calls', 'error', 'aborted'].includes(reason.kind)) {
    return { type: 'finish', reason: { kind: 'error', failure: { code: 'CODEX_WARM_FAILED', message: 'Codex warm request did not complete.' } } };
  }
  if (reason.kind !== 'error' && reason.kind !== 'aborted') return { type: 'finish', reason: { kind: reason.kind } };
  // Provider error text may echo request material. Return only bounded machine
  // metadata; never forward its message, response replay state, or credentials.
  const code = typeof reason.failure?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(reason.failure.code)
    ? reason.failure.code : 'CODEX_WARM_FAILED';
  return { type: 'finish', reason: { kind: reason.kind, failure: {
    code, message: reason.kind === 'aborted' ? 'Codex warm request cancelled.' : 'Codex warm request failed.',
    ...(Number.isInteger(reason.failure?.status) ? { status: reason.failure.status } : {}),
  } } };
}

/**
 * Background small request through the TRUE registered account adapter.
 *
 * prepareCall keeps the adapter's converter, attachment/file projection, model,
 * account-scoped store and fresh per-request OAuth resolution. Rebuilding with
 * PiAiAdapter would silently select a different converter and credential store.
 * The installed adapter uses maxRetries:0 and Harness retry is agent-loop-only.
 *
 * This is NOT an Agent turn: no followup/inject, session writes, or tool dispatch.
 * Only usage and a sanitized terminal outcome escape this wrapper. Tool schemas
 * and ordering remain intact; the current public GenerateOptions contract has
 * no tool_choice override. Asking for OK is not a hard generation/output bound.
 *
 * Images/files are resolved by the same native services and policies as real
 * requests. Missing attachments fail normally; no substitute/omission is made
 * here. A changed execution-world path or image service can change rendered
 * prefix bytes, so the caller must invalidate targets on environment changes.
 * The caller also owns the 10-second signal and finite activity window.
 */
export async function createCodexTransport(ctx, { provider, model }) {
  const route = readCodexRoute(ctx, provider, model);
  const llm = ctx.get('llm');
  if (typeof llm?.prepareCall !== 'function') unavailable('prepared call service unavailable');
  const assertCurrent = () => {
    if (ctx.get('llm') !== llm || readCodexRoute(ctx, provider, model).identity !== route.identity) unavailable('account route changed');
  };
  return Object.freeze({
    async *stream(options) {
      assertCurrent();
      if (options?.provider !== provider || options?.model !== model) unavailable('request route/model changed');
      if (typeof options.sessionId !== 'string' || !options.sessionId || options.sessionId.length > 256) unavailable('session cache key is required');
      if (!Array.isArray(options.messages)) unavailable('request prefix is required');
      if (!options.signal || typeof options.signal.throwIfAborted !== 'function') unavailable('caller cancellation signal is required');
      options.signal.throwIfAborted();
      // Deep-clone to prevent downstream serializers from mutating the captured
      // prefix. New object identity also removes the WeakSet AgentLoop marker.
      const { signal, ...plain } = options;
      const shadow = { ...structuredClone(plain), signal };
      shadow.messages.push({ role: 'user', content: [{ type: 'text', text: CODEX_WARM_PROMPT }] });
      const config = callConfig(shadow);
      let prepared;
      try { prepared = await llm.prepareCall(config, signal); }
      catch { signal.throwIfAborted(); unavailable('model could not be prepared'); }
      signal.throwIfAborted();
      assertCurrent();
      // A default/effort change must not rewrite an already-captured prefix.
      if (JSON.stringify(callConfig(prepared.config)) !== JSON.stringify(config)) unavailable('request defaults changed');
      let finished = false;
      try {
        for await (const chunk of prepared.stream(shadow)) {
          signal.throwIfAborted();
          assertCurrent();
          if (chunk?.type === 'usage') {
            const usage = {};
            for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
              if (Number.isFinite(chunk.usage?.[key]) && chunk.usage[key] >= 0) usage[key] = chunk.usage[key];
            }
            yield { type: 'usage', usage };
          } else if (chunk?.type === 'finish') {
            finished = true;
            yield terminal(chunk.reason);
            return;
          }
        }
      } catch {
        signal.throwIfAborted();
        unavailable('request failed or route changed');
      }
      if (!finished) yield terminal(null);
    },
  });
}
