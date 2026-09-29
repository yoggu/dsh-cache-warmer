import Schema from '@deepseek-ai/schemastery'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { resolveRequestIdentity } from './request-identity.js'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { createBoundedOpenRouter, readOpenRouterRoute, reviewedOpenRouterPricing } from './openrouter.js'
import { policyFor, nonnegative, warmingDecision, inputSize, windowEnd, nextDecisionAt,
  normalizeModelPolicies, normalizeCostChecks } from './policy.js'
import { observations } from './observations.js'
import { createModelDirectory } from './model-directory.js'

export const name = 'dsh-cache-warmer'
export const inject = ['llm', 'connection', 'sessions', 'sessionProjections', 'storageDomain', 'configEditor', 'settings', 'credentials']
export const Config = Schema.object({
  autoWarmNewChats: Schema.boolean().default(false),
  activeMinutes: Schema.number().min(0).max(1440).default(60),
  idleMinutes: Schema.number().min(0).max(1440).default(30),
  minExpectedBenefitUsd: Schema.number().min(0).max(1000).default(.05),
  idleContinuationPercent: Schema.number().step(1).min(0).max(100).default(15),
  useCodexDefaults: Schema.boolean().default(true),
  modelPolicies: Schema.array(Schema.object({
    provider: Schema.string().required(), model: Schema.string().required(),
    enabled: Schema.boolean().required(),
    cacheMinutes: Schema.union([Schema.const(null), Schema.number().min(1).max(10080)]),
    // Read legacy configs; normalize to one conservative lifetime before use.
    shortMinutes: Schema.union([Schema.const(null), Schema.number().min(1).max(10080)]),
    longMinutes: Schema.union([Schema.const(null), Schema.number().min(1).max(10080)]),
  })).default([]),
})
export const ROUTE_PATH = '/api/dsh-cache-warmer'
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const preferencesDomain = defineDomain({ name: 'dsh_cache_warmer', version: 1,
  tables: { preferences: domainTable(z.object({ enabled: z.boolean() }).strict()) } })
// Independent of transcript/projections. Survives reload without persisting prompts or credentials.
const usageDomain = defineDomain({ name: 'dsh_cache_warmer_usage', version: 1,
  tables: { summaries: domainTable(z.object({ attempts: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(), usd: z.number().nonnegative(),
    unpriced: z.number().int().nonnegative(), subscription: z.boolean(),
    inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(), lastAt: z.number(),
  }).strict()) } })

export function isCurrentRequest(session, options, isGenuineRequest = isAgentLoopRequest) {
  if (!session || !isGenuineRequest?.(options) || options.sessionId !== session.id) return false
  const header = session.requestHeader()
  if (!header) return false
  const c = header.config
  if (['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens'].some(k => options[k] !== c[k])
    || JSON.stringify(options.stop) !== JSON.stringify(c.stop)) return false
  return JSON.stringify(options.messages) === JSON.stringify(session.deriveMessages())
    && JSON.stringify(options.toolHistory) === JSON.stringify(session.toolHistory())
    && JSON.stringify(options.tools ?? []) === JSON.stringify(header.tools ?? [])
}

export function captureSessionSnapshot(session, options) {
  const header = session?.requestHeader?.()
  if (!header || !options) return null
  try {
    const { signal: _signal, ...plain } = options
    const copy = structuredClone(plain)
    return Object.freeze({ sessionId: String(session.id), header: JSON.stringify(header),
      toolHistory: JSON.stringify(session.toolHistory()), messages: copy.messages, options: copy,
      surfaceNodes: [...session.surface.nodes], replaceGeneration: session.surface.replaceGeneration,
      provider: header.config.provider, model: header.config.model })
  } catch { return null }
}

/** Append-only model/tool progress can retain the original prefix; fresh human input cannot. */
export function isCurrentSnapshot(session, snapshot) {
  if (!session || !snapshot || String(session.id) !== snapshot.sessionId
    || session.surface.replaceGeneration !== snapshot.replaceGeneration
    || JSON.stringify(session.requestHeader()) !== snapshot.header
    || JSON.stringify(session.toolHistory()) !== snapshot.toolHistory) return false
  const messages = session.deriveMessages()
  if (messages.length < snapshot.messages.length
    || JSON.stringify(messages.slice(0, snapshot.messages.length)) !== JSON.stringify(snapshot.messages)) return false
  if (messages.slice(snapshot.messages.length).some(m => m.role !== 'tool'
    && !(m.role === 'assistant' && m.source?.provider === snapshot.provider && m.source?.model === snapshot.model))) return false
  return snapshot.surfaceNodes.every((seq, i) => session.surface.nodes[i] === seq)
}

export function createShadowRequest(session, snapshot, policy, signal) {
  if (!isCurrentSnapshot(session, snapshot) || !policy
    || policy.provider !== snapshot.provider || policy.model !== snapshot.model || signal?.aborted) return null
  const options = { ...structuredClone(snapshot.options), sessionId: session.id, signal }
  // Only the reviewed bounded OpenRouter transport may send this shadow request.
  if (policy.kind !== 'openrouter') return null
  options.maxTokens = policy.maxOutputTokens
  return options
}

/** No AgentLoop, session writes, or tool dispatcher in this consumer. */
export async function consumeShadowStream(stream, { controller = new AbortController(), isCurrent = () => true,
  timeoutMs = 10_000, onUsage = () => {}, onSettling = () => {} } = {}) {
  let timeout, rejectAbort
  const check = () => {
    if (!isCurrent() && !controller.signal.aborted) controller.abort(new Error('cache warmer target changed'))
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('cache warmer aborted')
  }
  const consume = (async () => {
    let usage
    check()
    for await (const chunk of stream) {
      check()
      if (chunk?.type === 'usage') { usage = chunk.usage; onUsage(usage) }
      if (chunk?.type === 'finish') return { reason: chunk.reason, usage }
    }
    return { reason: null, usage }
  })()
  const aborted = new Promise((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason ?? new Error('cache warmer aborted'))
    if (controller.signal.aborted) rejectAbort()
    else controller.signal.addEventListener('abort', rejectAbort, { once: true })
  })
  onSettling(consume.then(() => {}, () => {}))
  timeout = setTimeout(() => controller.abort(new Error('cache warmer timeout')), timeoutMs)
  try { return await Promise.race([consume, aborted]) }
  finally {
    clearTimeout(timeout)
    controller.signal.removeEventListener('abort', rejectAbort)
    if (!controller.signal.aborted) controller.abort()
    void consume.catch(() => {})
  }
}

export async function runShadowWarm({ llm, session, snapshot, policy, signal, timeoutMs = 10_000,
  isCurrent = () => true, onUsage, onSettling }) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  try {
    const options = createShadowRequest(session, snapshot, policy, controller.signal)
    if (!options || !isCurrent()) return null
    return await consumeShadowStream(llm.stream(options), { controller, timeoutMs, onUsage, onSettling,
      isCurrent: () => isCurrent() && isCurrentSnapshot(session, snapshot) })
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!controller.signal.aborted) controller.abort()
  }
}

export function createWarmScheduler({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, run } = {}) {
  const timers = new Map(), generations = new Map()
  const cancel = key => {
    if (timers.has(key)) clearTimer(timers.get(key))
    timers.delete(key); generations.set(key, (generations.get(key) ?? 0) + 1)
  }
  const schedule = (key, at, payload) => {
    cancel(key)
    if (!nonnegative(at) || typeof run !== 'function') return false
    const generation = generations.get(key)
    const timer = setTimer(() => {
      timers.delete(key)
      if (generation === generations.get(key)) void Promise.resolve(run(key, payload)).catch(() => {})
    }, Math.max(0, at - now()))
    timer.unref?.()
    timers.set(key, timer); return true
  }
  return { schedule, cancel, size: () => timers.size,
    dispose: () => { for (const key of [...timers.keys()]) cancel(key); generations.clear() } }
}

export function updateRoute(state, provider, model, settings = {}, retention = 'long') {
  if (state.provider !== provider || state.model !== model) {
    state.lastCacheHitAt = null; state.lastCacheHitTokens = null; state.lastWarmAt = null
    state.lastWarmCacheHitTokens = null; state.usage = null
  }
  state.provider = provider; state.model = model
  state.cacheTtlMs = policyFor(provider, model, settings, retention)?.cacheTtlMs ?? null
}
export function cacheExpiryAt(state) {
  return nonnegative(state?.lastCacheHitAt) && nonnegative(state?.cacheTtlMs) && state.cacheTtlMs > 0
    ? state.lastCacheHitAt + state.cacheTtlMs : null
}
const REASONS = {
  unsupported: 'No compatible warming transport for this route.',
  'unknown-lifetime': 'No cache lifetime is configured for this model; observation only.',
  'policy-disabled': 'Warming is disabled by this model’s cache policy.',
  'retention-disabled': 'Prompt-cache retention is disabled for this route.',
  'unknown-pricing': 'Model pricing is unavailable; no automatic warming request will be sent.',
  'no-cache-evidence': 'Waiting for a genuine request to report reusable cached tokens.',
  'no-context': 'Waiting for a new completed request to capture the current context.',
  'request-in-flight': 'A genuine request is in progress; warming waits for its completion.',
  'request-identity-unavailable': 'The active Harness request identity could not be resolved; warming is disabled.',
  disabled: 'Warming is not enabled for this session.',
  'window-ended': 'The configured window from the last real model request has ended.',
  'insufficient-savings': 'The expected benefit is below your configured minimum.',
  'idle-probability-zero': 'Idle warming is disabled by the continuation probability setting.',
  'window-too-short': 'The next warming decision would fall outside the allowed window.',
  'transport-pending': 'Waiting for the previous background request to finish closing.',
  'decision-pending': 'Waiting for a warming decision to be scheduled.',
  warming: 'A background request is refreshing the cache.',
  'cache-elapsed': 'The estimated cache lifetime has elapsed; waiting for a real request.',
  stopped: 'Warming stopped after an error, cache miss, cancellation, or context change.',
  'no-storage': 'Durable preferences or usage accounting are unavailable; warming is disabled.',
  ready: '',
}

export function statusFor(state, config, enabled, now = Date.now()) {
  const policy = policyFor(state.provider, state.model, config, state.retention ?? 'long')
  const supported = Boolean(policy?.transportSupported && state.transportAvailable && policy.warmingAllowed && policy.cacheTtlMs)
  const windowEndsAt = windowEnd(state, config)
  let code = 'ready'
  if (!policy?.transportSupported) code = 'unsupported'
  else if (state.retention === 'none') code = 'retention-disabled'
  else if (policy.ruleSource === 'custom' && !policy.warmingAllowed) code = 'policy-disabled'
  else if (!policy.cacheTtlMs) code = 'unknown-lifetime'
  else if (!state.transportAvailable) code = 'unsupported'
  else if (!state.storageAvailable) code = 'no-storage'
  else if (!enabled) code = 'disabled'
  else if (state.warmFailureCount || state.warmError) code = 'stopped'
  else if (state.requestIdentityAvailable === false) code = 'request-identity-unavailable'
  else if (!state.lastRequestSnapshot) code = 'no-context'
  else if (!state.lastRequestFinished) code = 'request-in-flight'
  else if (windowEndsAt === null || now >= windowEndsAt) code = 'window-ended'
  else if (cacheExpiryAt(state) !== null && now >= cacheExpiryAt(state)) code = 'cache-elapsed'
  else if (state.warming && !state.warmAbortController?.signal.aborted) code = 'warming'
  else if (state.transportPending || state.warming) code = 'transport-pending'
  else if (state.decision && !state.decision.worthwhile) code = state.decision.reason
  else if (state.decisionStopped) code = 'stopped'
  else if (!state.decision) code = 'decision-pending'
  else if (!nonnegative(state.nextRefreshAt) || state.nextRefreshAt >= windowEndsAt) {
    code = nextDecisionAt(state, enabled, config, policy, now) === null ? 'window-too-short' : 'decision-pending'
  }
  // A worthwhile cost estimate is not proof of a timer. Only an actual retained
  // timer with all current gates satisfied may be presented as Scheduled.
  const warmingState = code === 'ready' ? 'scheduled' : code === 'warming' ? 'warming'
    : ['disabled', 'policy-disabled', 'retention-disabled', 'idle-probability-zero'].includes(code) ? 'disabled'
    : code === 'insufficient-savings' ? 'skipped'
    : ['no-context', 'request-in-flight', 'no-cache-evidence', 'transport-pending', 'decision-pending'].includes(code) ? 'waiting'
    : ['window-ended', 'window-too-short', 'cache-elapsed', 'stopped'].includes(code) ? 'stopped' : 'unavailable'
  return { sessionId: state.sessionId, enabled, supported, warmingState, reasonCode: code, reason: code === 'unsupported' && state.transportReason ? state.transportReason : REASONS[code] ?? '',
    route: state.provider && state.model ? `${state.provider}/${state.model}` : null, model: state.model,
    cacheTtlMs: state.cacheTtlMs, cacheExpiresAt: cacheExpiryAt(state), cacheEstimated: true,
    cacheEstimateSource: policy?.cacheEstimateSource ?? null,
    ruleSource: policy?.ruleSource ?? 'unknown', retention: policy?.retention ?? null,
    transportSupported: policy?.transportSupported === true, modelWarmingAllowed: policy?.warmingAllowed === true,
    lastCacheHitAt: state.lastCacheHitAt, lastCacheHitTokens: state.lastCacheHitTokens,
    lastWarmAt: state.lastWarmAt, lastWarmCacheHitTokens: state.lastWarmCacheHitTokens,
    lastRequestAt: state.lastRequestAt, lastRequestCompletedAt: state.lastRequestCompletedAt ?? null,
    requestCaptured: Boolean(state.lastRequestSnapshot), requestCompleted: state.lastRequestFinished === true,
    warmAttemptCount: state.warmAttemptCount, decision: state.decision,
    nextRefreshAt: supported && enabled && code === 'ready' ? state.nextRefreshAt : null,
    windowEndsAt, phase: state.agentRunning ? 'active' : state.runEndedAt !== null ? 'idle' : 'inactive',
    status: state.agentRunning ? 'running' : state.runEndedAt !== null ? 'idle' : 'inactive',
    warmingActive: warmingState === 'scheduled' || warmingState === 'warming' }
}

export async function apply(ctx, config = {}) {
  return applyWithTransport(ctx, config, createBoundedOpenRouter)
}

/** Injection seam for offline transport tests; plugin entry always uses bounded production transport. */
export async function applyWithTransport(ctx, config = {}, createTransport) {
  const isGenuineRequest = await resolveRequestIdentity(ctx.llm)
  if (!isGenuineRequest) ctx.logger?.warn?.('[dsh-cache-warmer] Active Harness request identity unavailable; warming disabled.')
  const settings = { autoWarmNewChats: config.autoWarmNewChats === true,
    activeMinutes: nonnegative(config.activeMinutes) ? Math.min(1440, config.activeMinutes) : 60,
    idleMinutes: nonnegative(config.idleMinutes) ? Math.min(1440, config.idleMinutes) : 30,
    useCodexDefaults: config.useCodexDefaults !== false, modelPolicies: normalizeModelPolicies(config.modelPolicies),
    ...normalizeCostChecks(config) }
  const settingsView = value => ({ ...value })
  const modelDirectory = createModelDirectory(ctx)
  const sessions = new Map(), newSessions = new Set(), runningWork = new Set()
  // The same reviewed pi-ai model drives both bounded OpenRouter transport and
  // hypothetical cost calculation. No optional pricing service or foreign route
  // can authorize a warm request. The fingerprint is rechecked before sending.
  const pricingFor = state => state.provider === 'openrouter'
    ? reviewedOpenRouterPricing(state.model) : null
  const estimateFor = price => price && ((buckets) => {
    if (!['input', 'output', 'cacheRead', 'cacheWrite'].every(key =>
      nonnegative(buckets[key] ?? 0))) return null
    const usage = { input: buckets.input ?? 0, output: buckets.output ?? 0,
      cacheRead: buckets.cacheRead ?? 0, cacheWrite: buckets.cacheWrite ?? 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    try {
      const amount = price.calculateCost(price.model, usage)?.total
      return nonnegative(amount) ? amount : null
    } catch { return null }
  })
  const economicDecision = state => {
    const price = pricingFor(state)
    const decision = warmingDecision({ usage: state.usage,
      estimate: estimateFor(price), policy: policyOf(state), active: state.agentRunning,
      observedWarmOutput: state.observedWarmOutput, settings })
    return { ...decision, pricingRevision: price?.fingerprint ?? null }
  }
  let preferences, accounting, disposed = false, storageHealthy = true, settingsUpdating = false
  ctx.sessionProjections.register(observations)
  const stateOf = id => {
    id = String(id)
    if (!sessions.has(id)) sessions.set(id, { sessionId: id, provider: null, model: null,
      lastCacheHitAt: null, lastCacheHitTokens: null, cacheTtlMs: null, usage: null, observedAt: null,
      lastRequestAt: null, lastRequestSnapshot: null, lastRequestFinished: false, lastRequestCompletedAt: null,
      requestIdentityAvailable: Boolean(isGenuineRequest), routeIdentity: null,
      runEndedAt: null, agentRunning: false, lastWarmAt: null, lastWarmCacheHitTokens: null,
      nextRefreshAt: null, warming: false, transportPending: false, warmAbortController: null, warmFailureCount: 0,
      warmAttemptCount: 0, warmError: null, decision: null, decisionStopped: false,
      observedWarmOutput: 0, transportAvailable: false, storageAvailable: false })
    return sessions.get(id)
  }
  const enabled = id => preferences?.table('preferences').get(String(id))?.enabled === true
  const routeIdentity = state => {
    if (state.provider !== 'openrouter') return null
    return JSON.stringify(readOpenRouterRoute(ctx))
  }
  const policyOf = state => policyFor(state.provider, state.model, settings, state.retention ?? 'unknown')
  const refreshTransport = state => {
    state.retention = 'unknown'; state.transportAvailable = false; state.transportReason = null
    if (state.provider === 'openrouter') try {
      const route = readOpenRouterRoute(ctx)
      // Retention is a planning assumption, not provider-reported expiry.
      state.retention = route.cacheRetention ?? (process.env.PI_CACHE_RETENTION === 'long' ? 'long' : 'short')
      state.transportAvailable = policyOf(state)?.transportSupported === true && state.retention !== 'none'
    } catch (error) {
      state.transportReason = /^Bounded OpenRouter unavailable: /.test(error?.message ?? '') ? error.message : null
    }
    state.cacheTtlMs = policyOf(state)?.cacheTtlMs ?? null
  }
  const hydrate = session => {
    const state = stateOf(session.id)
    const value = ctx.sessionProjections.stateOf(session, observations.key)
    if (value) {
      updateRoute(state, value.provider, value.model, settings, state.retention ?? 'unknown')
      if (value.usageAt !== state.observedAt) {
        state.evidenceInvalidated = false
        state.observedAt = value.usageAt; state.usage = value.usage
        state.lastCacheHitAt = value.lastCacheHitAt; state.lastCacheHitTokens = value.lastCacheHitTokens
      }
      if (!state.agentRunning) state.runEndedAt = value.endedAt
    }
    state.agentRunning = ctx.get('agents')?.get(session.id)?.status === 'running'
    state.storageAvailable = Boolean(preferences && accounting && storageHealthy)
    refreshTransport(state)
    return state
  }
  const decisionFor = economicDecision
  const cancel = (state, invalidate = false) => {
    scheduler.cancel(state.sessionId)
    state.warmAbortController?.abort(new Error('cache warmer cancelled'))
    state.nextRefreshAt = null
    // Keep warming true until the old task unwinds: never overlap calls.
    if (invalidate) { state.lastRequestSnapshot = null; state.lastRequestFinished = false }
  }
  const schedule = (session, state) => {
    if (disposed || settingsUpdating || state.warming || state.transportPending || !storageHealthy) return
    scheduler.cancel(state.sessionId); state.nextRefreshAt = null
    state.decision = decisionFor(state)
    const policy = policyOf(state)
    if (!policy || !state.storageAvailable || !state.transportAvailable || !state.lastRequestFinished
      || !isCurrentSnapshot(session, state.lastRequestSnapshot)) return
    try { if (state.routeIdentity !== routeIdentity(state)) { cancel(state, true); return } } catch { cancel(state, true); return }
    const at = nextDecisionAt(state, enabled(session.id), settings, policy)
    // A failed economics test stays stopped for this phase until a real request.
    if (at === null || !state.decision.worthwhile) return
    state.nextRefreshAt = at
    scheduler.schedule(state.sessionId, at, { snapshot: state.lastRequestSnapshot,
      pricingRevision: state.decision.pricingRevision })
  }
  const persistUsage = async (state, usage, completed, attempted = true) => {
    if (!accounting) return
    const table = accounting.table('summaries')
    const previous = table.get(state.sessionId) ?? { attempts: 0, completed: 0, usd: 0, unpriced: 0,
      subscription: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, lastAt: 0 }
    const price = pricingFor(state), estimate = estimateFor(price)
    const usd = usage && estimate && inputSize(usage) !== null && nonnegative(usage.outputTokens)
      ? estimate({ input: usage.inputTokens, output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0 }) : null
    await table.put(state.sessionId, { attempts: previous.attempts + Number(attempted),
      completed: previous.completed + Number(completed), usd: previous.usd + (usd ?? 0),
      unpriced: previous.unpriced + Number(usd === null), subscription: previous.subscription || policyOf(state)?.subscription === true,
      inputTokens: previous.inputTokens + (nonnegative(usage?.inputTokens) ? usage.inputTokens : 0),
      outputTokens: previous.outputTokens + (nonnegative(usage?.outputTokens) ? usage.outputTokens : 0),
      cacheReadTokens: previous.cacheReadTokens + (nonnegative(usage?.cacheReadTokens) ? usage.cacheReadTokens : 0), lastAt: Date.now() })
  }
  const run = async (sessionId, payload) => {
    const snapshot = payload?.snapshot
    const session = ctx.sessions.get(sessionId), state = sessions.get(sessionId)
    const policy = state && policyOf(state)
    if (!session || !state || !policy || disposed || settingsUpdating || state.warming || state.transportPending || !storageHealthy || !state.storageAvailable
      || !enabled(sessionId) || snapshot !== state.lastRequestSnapshot || !isCurrentSnapshot(session, snapshot)) return
    state.nextRefreshAt = null
    state.decision = decisionFor(state)
    if (state.decision.pricingRevision !== payload.pricingRevision) {
      state.decisionStopped = true; return
    }
    if (nextDecisionAt(state, true, settings, policy) === null || !state.decision.worthwhile) return
    const controller = new AbortController()
    state.warmAbortController = controller; state.warming = true
    const deadline = setTimeout(() => controller.abort(new Error('cache warmer deadline')),
      Math.max(1, Math.min(10_000, windowEnd(state, settings) - Date.now())))
    let usage, attempted = false, completed = false
    const accountingTarget = { sessionId, provider: state.provider, model: state.model }
    const current = () => {
      if (disposed || settingsUpdating || controller.signal.aborted || !enabled(sessionId) || state.lastRequestSnapshot !== snapshot
        || !isCurrentSnapshot(session, snapshot) || Date.now() >= windowEnd(state, settings)) return false
      try { return state.routeIdentity === routeIdentity(state) } catch { return false }
    }
    const pricingCurrent = () => {
      const fresh = decisionFor(state)
      return fresh.worthwhile && fresh.pricingRevision === payload.pricingRevision
    }
    try {
      if (!current()) return
      if (state.provider !== 'openrouter' || policy.transportSupported !== true) return
      const transport = await createTransport(ctx, { model: state.model })
      if (!current()) return
      if (!pricingCurrent()) { state.decisionStopped = true; return }
      attempted = true; state.warmAttemptCount++
      const result = await runShadowWarm({ llm: transport, session, snapshot, policy, signal: controller.signal,
        isCurrent: () => current() && pricingCurrent(), onUsage: value => { usage = value },
        onSettling: settling => {
          state.transportPending = true
          void settling.then(() => {
            state.transportPending = false
            if (!state.warming && !disposed) schedule(session, state)
          })
        } })
      completed = Boolean(result && ['stop', 'max-tokens'].includes(result.reason?.kind))
      if (!current()) return
      if (!completed || !(usage?.cacheReadTokens > 0)) throw new Error('warm failed or no cache hit')
      state.lastWarmAt = Date.now(); state.lastCacheHitAt = state.lastWarmAt
      state.lastCacheHitTokens = usage.cacheReadTokens; state.lastWarmCacheHitTokens = usage.cacheReadTokens
      state.observedWarmOutput = Math.max(state.observedWarmOutput, usage.outputTokens ?? 0)
    } catch {
      if (state.lastRequestSnapshot === snapshot) { state.warmFailureCount++; state.warmError = 'stopped' }
    } finally {
      clearTimeout(deadline)
      if (nonnegative(usage?.outputTokens)) state.observedWarmOutput = Math.max(state.observedWarmOutput, usage.outputTokens)
      if (attempted) {
        try { await persistUsage(accountingTarget, usage, completed) }
        catch { storageHealthy = false; state.storageAvailable = false; state.warmError = 'stopped'; state.warmFailureCount++ }
      }
      if (state.warmAbortController === controller) {
        state.warmAbortController = null; state.warming = false
        if (!disposed && !state.warmFailureCount
          && (!controller.signal.aborted || state.lastRequestSnapshot !== snapshot)) schedule(session, state)
      }
    }
  }
  const scheduler = createWarmScheduler({ run: (id, snapshot) => {
    const work = run(id, snapshot); runningWork.add(work)
    void work.finally(() => runningWork.delete(work)).catch(() => {})
    return work
  } })
  const preference = async (id, value) => {
    if (!preferences) throw new Error('preferences unavailable')
    await preferences.table('preferences').put(String(id), { enabled: value })
  }

  ctx.on('session/created', session => {
    newSessions.add(String(session.id))
    if (preferences && preferences.table('preferences').get(String(session.id)) === undefined)
      void preference(session.id, session.header?.origin !== 'subagent' && settings.autoWarmNewChats).catch(() => {})
  })
  ctx.on('session/event', (session, event) => {
    const state = stateOf(session.id)
    if (event.type === 'request/header' || event.type === 'request/context' || event.type === 'user/message'
      || (event.surfaceOp && event.surfaceOp !== 'append')) {
      cancel(state, true)
      if (event.surfaceOp && event.surfaceOp !== 'append') state.lastCacheHitAt = null
      return
    }
    if (event.type === 'assistant/message') {
      hydrate(session)
      if (state.lastRequestSnapshot && !event.data.interrupted && isCurrentSnapshot(session, state.lastRequestSnapshot)) {
        state.lastRequestFinished = true; state.lastRequestCompletedAt = event.time
        schedule(session, state)
      } else if (event.data.interrupted) cancel(state, true)
    } else if (event.type === 'turn/end') {
      if (event.data.reason?.kind !== 'completed') { cancel(state, true); state.warmError = 'stopped' }
      else { state.runEndedAt = event.time; state.agentRunning = false; schedule(session, state) }
    } else if (event.surfaceOp && state.lastRequestSnapshot && !isCurrentSnapshot(session, state.lastRequestSnapshot)) cancel(state, true)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    const state = stateOf(agent.id)
    state.agentRunning = status === 'running'
    if (status === 'running') { cancel(state, true); state.runEndedAt = null }
    else {
      state.runEndedAt = Date.now()
      // Idle transition can shorten an in-flight active deadline: abort and stop,
      // never let a refresh extend the deadline or silently cross phases.
      if (state.warming) { cancel(state); state.warmError = 'stopped' }
      const session = ctx.sessions.get(agent.id)
      if (session) schedule(session, state)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = sessions.get(String(agent.id))
    if (state) cancel(state, true)
  })
  ctx.on('session/disposed', session => {
    const state = sessions.get(String(session.id))
    if (state) cancel(state, true)
    sessions.delete(String(session.id)); newSessions.delete(String(session.id))
  })
  // Any provider/account/configuration change invalidates captured transport assumptions.
  const invalidateRoutes = () => {
    modelDirectory.invalidate()
    for (const state of sessions.values()) {
      cancel(state, true)
      state.lastCacheHitAt = null; state.lastCacheHitTokens = null
      state.usage = null; state.evidenceInvalidated = true
    }
  }
  ctx.on('settings/document-updated', invalidateRoutes)
  ctx.on('llm/adapters-updated', invalidateRoutes)
  ctx.on('llm/stream', (options, next) => {
    if (settingsUpdating || !isGenuineRequest?.(options) || !safeId(options.sessionId)) return next()
    const session = ctx.sessions.get(options.sessionId)
    if (!session) return next()
    const state = hydrate(session)
    cancel(state, true)
    if (!isCurrentRequest(session, options, isGenuineRequest) || session.header?.origin === 'subagent') return next()
    updateRoute(state, options.provider, options.model, settings, state.retention ?? 'unknown')
    try { state.routeIdentity = routeIdentity(state) } catch { state.routeIdentity = null }
    state.lastRequestSnapshot = captureSessionSnapshot(session, options)
    state.lastRequestAt = Date.now(); state.lastWarmAt = null; state.warmFailureCount = 0
    state.warmAttemptCount = 0; state.warmError = null; state.decisionStopped = false; state.decision = null
    return next()
  }, { global: true })

  const makeStatus = id => {
    const session = safeId(id) && ctx.sessions.get(id)
    if (!session) return { sessionId: id, enabled: false, supported: false, status: 'unavailable', warmingState: 'unavailable',
      reason: 'Session is unavailable.', reasonCode: 'session-unavailable', cacheTtlMs: null, cacheExpiresAt: null }
    const state = hydrate(session)
    const fresh = decisionFor(state)
    if (state.nextRefreshAt !== null && (!fresh.worthwhile || fresh.pricingRevision !== state.decision?.pricingRevision)) {
      cancel(state); state.decisionStopped = true
    }
    state.decision = fresh
    return { ...statusFor(state, settings, enabled(id)), warmUsage: accounting?.table('summaries').get(String(id)) ?? null }
  }
  // A route must always answer. The shared Fetch channel does not catch a
  // handler rejection, so a throwing or never-settling read would leave the
  // browser waiting on a connection it can never reuse — which starves every
  // later request from the same page. Every branch is bounded and coded.
  const bounded = (work, ms, code) => {
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new Error(code); error.code = code; reject(error) }, ms)
    })
    return Promise.race([Promise.resolve(work), deadline]).finally(() => clearTimeout(timer))
  }
  const routeRegistration = ctx.connection.fetch.register({ path: ROUTE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async request => {
      const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
      const url = new URL(request.url)
      if (request.method === 'GET') {
        try {
          if (url.searchParams.get('scope') === 'models') {
            return json(await bounded(modelDirectory.load(), 12000, 'model-request-timeout'))
          }
          return json(url.searchParams.get('scope') === 'settings' ? settingsView(settings) : makeStatus(url.searchParams.get('sessionId')))
        } catch (cause) {
          const code = cause?.code === 'model-request-timeout' ? 'model-request-timeout' : 'model-request-failed'
          ctx.logger?.warn?.(`[dsh-cache-warmer] GET ${url.search} failed: ${cause?.stack ?? cause}`)
          return json({ error: code }, code === 'model-request-timeout' ? 504 : 500)
        }
      }
      let body
      try { body = await request.json() } catch { return json({ error: 'invalid-json' }, 400) }
      if (body?.scope === 'settings') {
        const next = { autoWarmNewChats: body.autoWarmNewChats, activeMinutes: body.activeMinutes, idleMinutes: body.idleMinutes,
          // An old Client saving only base settings must not erase advanced rules.
          useCodexDefaults: body.useCodexDefaults === undefined ? settings.useCodexDefaults : body.useCodexDefaults }
        if (typeof next.autoWarmNewChats !== 'boolean' || typeof next.useCodexDefaults !== 'boolean'
          || ![next.activeMinutes, next.idleMinutes].every(v => Number.isInteger(v) && v >= 0 && v <= 1440)) return json({ error: 'invalid-settings' }, 400)
        try {
          Object.assign(next, normalizeCostChecks({
            minExpectedBenefitUsd: body.minExpectedBenefitUsd === undefined ? settings.minExpectedBenefitUsd : body.minExpectedBenefitUsd,
            idleContinuationPercent: body.idleContinuationPercent === undefined ? settings.idleContinuationPercent : body.idleContinuationPercent,
          }))
        } catch { return json({ error: 'invalid-settings' }, 400) }
        try { next.modelPolicies = normalizeModelPolicies(body.modelPolicies === undefined ? settings.modelPolicies : body.modelPolicies) }
        catch { return json({ error: 'invalid-model-policies' }, 400) }
        const entry = ctx.configEditor.entries().find(e => e.options?.name === name && e.options?.id === name)
        if (!entry) return json({ error: 'settings-unavailable' }, 503)
        if (settingsUpdating) return json({ error: 'settings-update-in-progress' }, 409)
        settingsUpdating = true
        try {
          // Stop old-policy timers before persisting/reconciling. No in-flight
          // refresh may continue under a policy the user just disabled.
          for (const state of sessions.values()) cancel(state, true)
          await ctx.configEditor.edit(entry, () => next)
          // The owning fiber may have reloaded; keep this instance safe as well.
          Object.assign(settings, next)
          return json(settingsView(next))
        } catch { return json({ error: 'settings-save-failed' }, 503) }
        finally {
          for (const state of sessions.values()) cancel(state, true)
          settingsUpdating = false
        }
      }
      if (!safeId(body?.sessionId) || typeof body.enabled !== 'boolean') return json({ error: 'invalid-preference' }, 400)
      const session = ctx.sessions.get(body.sessionId)
      if (!session) return json({ error: 'session-unavailable' }, 404)
      if (!preferences || !accounting) return json({ error: 'storage-unavailable' }, 503)
      try {
        await preference(body.sessionId, body.enabled)
        const state = hydrate(session)
        if (body.enabled) schedule(session, state)
        else cancel(state)
        return json(makeStatus(body.sessionId))
      } catch { return json({ error: 'preference-save-failed' }, 503) }
    } })
  const opened = Promise.allSettled([
    ctx.storageDomain.open(preferencesDomain).then(p => { preferences = p }),
    ctx.storageDomain.open(usageDomain).then(a => { accounting = a }),
  ]).then(async () => {
    if (disposed) return
    if (!preferences || !accounting) {
      ctx.logger?.warn?.('[dsh-cache-warmer] Storage unavailable; warming disabled.')
      return
    }
    for (const id of newSessions) if (preferences.table('preferences').get(id) === undefined)
      await preference(id, ctx.sessions.get(id)?.header?.origin !== 'subagent' && settings.autoWarmNewChats)
  }).catch(() => { ctx.logger?.warn?.('[dsh-cache-warmer] Preference initialization failed; warming disabled.') })
  ctx.effect(() => async () => {
    disposed = true; scheduler.dispose(); modelDirectory.dispose()
    for (const state of sessions.values()) cancel(state, true)
    await Promise.allSettled([...runningWork])
    const unregister = await Promise.resolve(routeRegistration).catch(() => null)
    await unregister?.(); await opened
    await preferences?.close(); await accounting?.close()
    sessions.clear()
  }, 'cache-warmer lifecycle')
}
