import Schema from '@deepseek-ai/schemastery'
import { createBoundedOpenRouter, readOpenRouterRoute, inputBytesForBudget, OPENROUTER_MODEL } from './openrouter.js'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const name = 'dsh-cache-warmer'
export const inject = ['llm', 'connection', 'sessions', 'storageDomain', 'configEditor', 'settings', 'credentials']

export const Config = Schema.object({
  autoWarmNewChats: Schema.boolean().default(false),
  activeMinutes: Schema.number().min(0).max(24 * 60).default(60),
  idleMinutes: Schema.number().min(0).max(24 * 60).default(30),
  refreshMinutes: Schema.number().min(1).max(60).default(5),
  maxBudgetUsd: Schema.number().min(.05).max(10).default(1),
})

export const ROUTE_PATH = '/api/dsh-cache-warmer'
export const ACTIVE_WINDOW_MS = 60 * 60 * 1000
export const IDLE_WINDOW_MS = 30 * 60 * 1000
export const MAX_WARM_OUTPUT_TOKENS = 32

const preferencesDomain = defineDomain({
  name: 'dsh_cache_warmer',
  version: 1,
  tables: {
    preferences: domainTable(z.object({ enabled: z.boolean() }).strict()),
  },
})

// Verified by capped live synthetic reuse plus offline serializer/price-limit tests.
// No TTL claim: routing and cache retention remain provider-controlled.
const PROVEN_WARM_POLICIES = Object.freeze([Object.freeze({
  provider: 'openrouter', model: OPENROUTER_MODEL,
  wireVerified: true, cacheSemanticsVerified: true,
  wireMaxTokensField: 'max_completion_tokens', maxOutputTokens: 8,
  cacheTtlMs: null, bestEffort: true, refreshIntervalMs: 300_000,
})])

const finiteNonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 256

/** Pure route gate: only a future exact, reviewed policy can admit warming. */
export function admitWarmRoute(provider, model, policies = PROVEN_WARM_POLICIES) {
  if (typeof provider !== 'string' || typeof model !== 'string' || !Array.isArray(policies)) return false
  return policies.some(policy => policy.provider === provider
    && policy.model === model
    && policy.wireVerified === true
    && policy.cacheSemanticsVerified === true
    && Number.isInteger(policy.maxOutputTokens)
    && policy.maxOutputTokens > 0
    && policy.maxOutputTokens <= MAX_WARM_OUTPUT_TOKENS
    && ['max_tokens', 'max_completion_tokens'].includes(policy.wireMaxTokensField)
    && ((finiteNonNegative(policy.cacheTtlMs) && policy.cacheTtlMs > 0)
      || (policy.bestEffort === true && policy.refreshIntervalMs >= 60_000)))
}

/**
 * Validate that a marked request still describes the current committed session.
 * No session method here writes or mutates the session.
 */
export function isCurrentRequest(session, options) {
  if (session === undefined || options === null || typeof options !== 'object') return false
  if (!isAgentLoopRequest(options) || options.sessionId !== session.id) return false
  const header = session.requestHeader()
  if (header === undefined) return false
  const derivedMessages = session.deriveMessages()
  const toolHistory = session.toolHistory()
  const callConfig = header.config
  if (options.provider !== callConfig.provider || options.model !== callConfig.model
    || options.reasoningEffort !== callConfig.reasoningEffort
    || options.temperature !== callConfig.temperature
    || options.maxTokens !== callConfig.maxTokens
    || JSON.stringify(options.stop) !== JSON.stringify(callConfig.stop)) return false
  if (JSON.stringify(options.messages) !== JSON.stringify(derivedMessages)) return false
  if (JSON.stringify(options.toolHistory) !== JSON.stringify(toolHistory)) return false
  if (JSON.stringify(options.tools ?? []) !== JSON.stringify(header.tools ?? [])) return false
  return true
}

/** Capture the exact current request prefix used for later shadow freshness checks. */
export function captureSessionSnapshot(session, requestOptions) {
  const header = session?.requestHeader?.()
  if (!header) return null
  let messages
  try { messages = structuredClone(requestOptions?.messages ?? session.deriveMessages()) }
  catch { return null }
  const { signal: _originalSignal, ...plainOptions } = requestOptions ?? {}
  return Object.freeze({
    sessionId: String(session.id),
    header: JSON.stringify(header),
    toolHistory: JSON.stringify(session.toolHistory()),
    messages,
    surfaceNodes: [...session.surface.nodes],
    replaceGeneration: session.surface.replaceGeneration,
    prefix: requestFingerprint(session, messages),
    provider: header.config.provider,
    model: header.config.model,
    options: requestOptions ? { ...plainOptions, messages } : null,
  })
}

/** Permit only the original prefix plus its one committed assistant response. */
export function isCurrentSnapshot(session, snapshot) {
  if (!session || !snapshot || String(session.id) !== snapshot.sessionId) return false
  const header = session.requestHeader()
  if (header === undefined || session.surface.replaceGeneration !== snapshot.replaceGeneration
    || JSON.stringify(header) !== snapshot.header
    || JSON.stringify(session.toolHistory()) !== snapshot.toolHistory) return false
  const currentMessages = session.deriveMessages()
  if (currentMessages.length < snapshot.messages.length || currentMessages.length > snapshot.messages.length + 1) return false
  if (JSON.stringify(currentMessages.slice(0, snapshot.messages.length)) !== JSON.stringify(snapshot.messages)) return false
  if (currentMessages.length > snapshot.messages.length) {
    const response = currentMessages.at(-1)
    if (response?.role !== 'assistant' || response.source?.provider !== snapshot.provider
      || response.source?.model !== snapshot.model) return false
  }
  const currentNodes = session.surface.nodes
  return currentNodes.length >= snapshot.surfaceNodes.length
    && snapshot.surfaceNodes.every((seq, index) => currentNodes[index] === seq)
}

/** Construct a bounded, unmarked model request; it never enters AgentLoop. */
export function createShadowRequest(session, snapshot, policy, signal) {
  if (!isCurrentSnapshot(session, snapshot) || !policy || !admitWarmRoute(policy.provider, policy.model, [policy])) return null
  if (!snapshot.options || policy.provider !== snapshot.provider || policy.model !== snapshot.model
    || policy.maxOutputTokens > MAX_WARM_OUTPUT_TOKENS) return null
  // Preserve the original envelope: tools, tool history, system prompt, and
  // provider-specific controls are part of cache identity, not optional extras.
  return Object.freeze({
    ...snapshot.options,
    provider: policy.provider,
    model: policy.model,
    messages: snapshot.messages,
    maxTokens: policy.maxOutputTokens,
    sessionId: session.id,
    signal,
  })
}

/** Consume a fake or real shadow stream without ever dispatching tool calls. */
export async function consumeShadowStream(stream, { signal, controller = new AbortController(), isCurrent = () => true, timeoutMs = 10_000 } = {}) {
  const abort = () => { if (!controller.signal.aborted) controller.abort(signal?.reason) }
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  let timeout
  const consume = (async () => {
    let usage
    for await (const chunk of stream) {
      if (controller.signal.aborted || !isCurrent()) {
        if (!controller.signal.aborted) controller.abort(new Error('cache warmer request became stale'))
        break
      }
      if (chunk?.type === 'usage') usage = chunk.usage
      if (chunk?.type === 'finish') return { reason: chunk.reason, usage }
    }
    return { reason: null, usage }
  })()
  const aborted = new Promise((_, reject) => {
    const rejectAbort = () => reject(controller.signal.reason ?? new Error('cache warmer aborted'))
    if (controller.signal.aborted) rejectAbort()
    else controller.signal.addEventListener('abort', rejectAbort, { once: true })
  })
  try {
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('cache warmer timeout')
        if (!controller.signal.aborted) controller.abort(error)
        reject(error)
      }, timeoutMs)
    })
    return await Promise.race([consume, timedOut, aborted])
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    if (!controller.signal.aborted) controller.abort()
    void consume.catch(() => {})
  }
}

/** Dispatch a gated shadow call without admitting it to AgentLoop or tools. */
export async function runShadowWarm({ llm, session, snapshot, policy, signal, timeoutMs = 10_000, isCurrent = () => true }) {
  if (!llm || !session || !snapshot || !admitWarmRoute(policy?.provider, policy?.model, [policy])) return null
  const controller = new AbortController()
  const abort = () => { if (!controller.signal.aborted) controller.abort(signal?.reason) }
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const options = createShadowRequest(session, snapshot, policy, controller.signal)
  if (!options) {
    signal?.removeEventListener('abort', abort)
    return null
  }
  try {
    const stream = llm.stream(options)
    return await consumeShadowStream(stream, {
      controller,
      timeoutMs,
      isCurrent: () => isCurrent() && isCurrentSnapshot(session, snapshot),
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!controller.signal.aborted) controller.abort()
  }
}

/** Exponential backoff with a finite ceiling for one session's warm attempts. */
export function warmBackoffMs(attempt, policy = {}) {
  const base = finiteNonNegative(policy.initialBackoffMs) ? policy.initialBackoffMs : 1_000
  const ceiling = finiteNonNegative(policy.maxBackoffMs) ? policy.maxBackoffMs : 30_000
  return Math.min(ceiling, base * (2 ** Math.max(0, Math.floor(attempt))))
}

/** One generation-token timer per session, cancellable and teardown-safe. */
export function createWarmScheduler({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, run } = {}) {
  const timers = new Map()
  const generations = new Map()
  const cancel = key => {
    if (timers.has(key)) clearTimer(timers.get(key))
    timers.delete(key)
    generations.set(key, (generations.get(key) ?? 0) + 1)
  }
  const schedule = (key, at, payload) => {
    cancel(key)
    if (!finiteNonNegative(at) || typeof run !== 'function') return false
    const generation = generations.get(key)
    const timer = setTimer(() => {
      timers.delete(key)
      if (generations.get(key) !== generation) return
      void Promise.resolve(run(key, payload)).catch(() => {})
    }, Math.max(0, at - now()))
    timers.set(key, timer)
    return true
  }
  const dispose = () => { for (const key of [...timers.keys()]) cancel(key) }
  return Object.freeze({ schedule, cancel, dispose, size: () => timers.size })
}

/** Best-effort refresh cadence is independent of unknowable provider expiry. */
export function nextBestEffortWarmAt(state, enabled, settings, now = Date.now()) {
  if (!enabled || !finiteNonNegative(state.lastRequestAt) || state.warmAttemptCount >= 3 || state.warmFailureCount > 0) return null
  const end = requestWindowEnd(state, settings)
  const base = state.lastWarmAt ?? state.lastRequestAt
  const due = Math.max(now, base + settings.refreshMinutes * 60_000)
  return end !== null && due < end ? due : null
}

/** Calculate the next finite refresh instant; unknown TTL/window stays disabled. */
export function nextWarmAt(state, enabled, activeMinutes, idleMinutes, now = Date.now()) {
  if (!enabled || !finiteNonNegative(state?.cacheTtlMs) || state.cacheTtlMs <= 0
    || !finiteNonNegative(state?.lastCacheHitAt)) return null
  const windowEndsAt = state.agentRunning
    ? (finiteNonNegative(state.lastRequestAt) ? state.lastRequestAt + activeMinutes * 60_000 : null)
    : (finiteNonNegative(state.runEndedAt) ? state.runEndedAt + idleMinutes * 60_000 : null)
  if (windowEndsAt === null || now >= windowEndsAt) return null
  const due = state.lastCacheHitAt + state.cacheTtlMs - Math.min(30_000, state.cacheTtlMs * 0.1)
  return due < windowEndsAt ? Math.max(now, due) : null
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function streamWithObserver(stream, observer) {
  return (async function* () {
    try {
      for await (const chunk of stream) {
        try { observer(chunk) } catch { /* telemetry must never affect the model stream */ }
        yield chunk
      }
    } catch (error) {
      throw error
    }
  })()
}

/** A changed route must not inherit a previous provider's cache evidence. */
export function updateRoute(state, provider, model) {
  if (state.provider !== provider || state.model !== model) {
    state.cacheTtlMs = null
    state.lastCacheHitAt = null
    state.lastCacheHitTokens = null
    state.lastWarmAt = null
    state.lastWarmCacheHitTokens = null
  }
  state.provider = provider
  state.model = model
}

export function cacheExpiryAt(state) {
  if (!finiteNonNegative(state?.lastCacheHitAt) || !finiteNonNegative(state?.cacheTtlMs) || state.cacheTtlMs === 0) return null
  return state.lastCacheHitAt + state.cacheTtlMs
}

function activeWindowEnd(state, activeMinutes) {
  return finiteNonNegative(state.lastRequestAt) && state.agentRunning
    ? state.lastRequestAt + activeMinutes * 60_000
    : null
}

function idleWindowEnd(state, idleMinutes) {
  return finiteNonNegative(state.runEndedAt) && !state.agentRunning
    ? state.runEndedAt + idleMinutes * 60_000
    : null
}

export function statusFor(state, config, enabled, now = Date.now()) {
  const windowEndsAt = state.agentRunning
    ? activeWindowEnd(state, config.activeMinutes)
    : idleWindowEnd(state, config.idleMinutes)
  const cacheExpiresAt = cacheExpiryAt(state)
  const warmSupported = admitWarmRoute(state.provider, state.model) && state.transportAvailable === true
  let phase = 'inactive'
  if (state.agentRunning) phase = 'active'
  else if (state.runEndedAt !== null) phase = 'idle'
  const currentWindowOpen = windowEndsAt !== null && now < windowEndsAt
  let reason = ''
  if (!warmSupported) reason = 'Observation only: bounded request, replay and cache benefit have not been verified for this route.'
  else if (state.storageAvailable !== true) reason = 'Durable preferences are unavailable; warming is fail-closed.'
  else if (!enabled) reason = 'Warming is not enabled for this session.'
  else if (!currentWindowOpen) reason = 'The configured activity window has ended.'
  return {
    sessionId: state.sessionId,
    enabled,
    route: state.provider && state.model ? `${state.provider}/${state.model}` : null,
    model: state.model,
    supported: warmSupported,
    reason: state.warmError || (state.warmAttemptCount >= 3 ? 'The three-attempt safety budget for this request has been used.' : reason),
    cacheTtlMs: state.cacheTtlMs,
    cacheExpiresAt,
    lastCacheHitTokens: state.lastCacheHitTokens,
    lastCacheHitAt: state.lastCacheHitAt,
    lastWarmAt: state.lastWarmAt,
    lastWarmCacheHitTokens: state.lastWarmCacheHitTokens,
    warmFailureCount: state.warmFailureCount,
    refreshIntervalMs: config.refreshMinutes * 60_000,
    warmAttemptCount: state.warmAttemptCount,
    reasonCode: state.warmError ? 'warm-stopped' : warmSupported ? 'best-effort' : state.provider?.startsWith('codex') ? 'codex-unbounded' : state.provider === 'openrouter' ? 'openrouter-unverified' : 'provider-unknown',
    nextRefreshAt: warmSupported ? state.nextRefreshAt : null,
    windowEndsAt,
    phase,
    status: state.agentRunning ? 'running' : state.runEndedAt !== null ? 'idle' : 'inactive',
    warmingActive: enabled && state.storageAvailable === true && warmSupported && currentWindowOpen
      && state.warmAttemptCount < 3 && state.warmFailureCount === 0 && Boolean(state.nextRefreshAt || state.warming),
  }
}

function statusState(sessionId) {
  return {
    sessionId,
    provider: null,
    model: null,
    cacheTtlMs: null,
    lastCacheHitAt: null,
    lastCacheHitTokens: null,
    lastWarmAt: null,
    lastWarmCacheHitTokens: null,
    lastCacheHitEventTime: null,
    lastCacheHitEventSeq: -1,
    lastEventSeq: -1,
    preferenceInitialized: false,
    lastRequestAt: null,
    lastRequestSnapshot: null,
    lastRequestFinished: false,
    runEndedAt: null,
    agentRunning: false,
    surfaceGeneration: null,
    requestPrefix: null,
    storageAvailable: false,
    warmAbortController: null,
    warmFailureCount: 0,
    nextRefreshAt: null,
    warming: false,
    warmAttemptCount: 0,
    warmError: null,
  }
}

function requestFingerprint(session, messages = session.deriveMessages()) {
  const header = session.requestHeader()
  if (header === undefined) return null
  return JSON.stringify({
    header,
    toolHistory: session.toolHistory(),
    surface: session.surface.nodes,
    contentGeneration: session.surface.contentGeneration,
    replaceGeneration: session.surface.replaceGeneration,
    messages,
  })
}

function selectedPolicy(provider, model) {
  return PROVEN_WARM_POLICIES.find(policy => policy.provider === provider && policy.model === model
    && admitWarmRoute(provider, model, [policy]))
}

function requestWindowEnd(state, settings) {
  if (state.agentRunning) {
    return finiteNonNegative(state.lastRequestAt) ? state.lastRequestAt + settings.activeMinutes * 60_000 : null
  }
  return finiteNonNegative(state.runEndedAt) ? state.runEndedAt + settings.idleMinutes * 60_000 : null
}

/** Host half. Observation is independent of warm admission and preserves chunks. */
export function apply(ctx, config = {}) {
  const settings = {
    maxBudgetUsd: Number.isFinite(config.maxBudgetUsd) && config.maxBudgetUsd >= .05 && config.maxBudgetUsd <= 10 ? config.maxBudgetUsd : 1,
    autoWarmNewChats: config.autoWarmNewChats === true,
    activeMinutes: finiteNonNegative(config.activeMinutes) ? config.activeMinutes : 60,
    idleMinutes: finiteNonNegative(config.idleMinutes) ? config.idleMinutes : 30,
    refreshMinutes: Number.isInteger(config.refreshMinutes) && config.refreshMinutes >= 1 && config.refreshMinutes <= 60 ? config.refreshMinutes : 5,
  }
  const sessions = new Map()
  const agents = new Map()
  const globalSettings = () => ({ autoWarmNewChats: settings.autoWarmNewChats,
    activeMinutes: settings.activeMinutes, idleMinutes: settings.idleMinutes, refreshMinutes: settings.refreshMinutes, maxBudgetUsd: settings.maxBudgetUsd })
  const saveGlobalSettings = async next => {
    const entry = ctx.configEditor.entries().find(item => item.options?.name === name && item.options?.id === name)
    if (!entry) throw new Error('cache-warmer configuration entry unavailable')
    await ctx.configEditor.edit(entry, current => ({ ...current, ...next }))
  }
  let domain
  let disposed = false
  let domainOpen
  let runScheduledWarm = async () => undefined
  const newSessionIds = new Set()
  const warmScheduler = createWarmScheduler({ run: (sessionId, payload) => runScheduledWarm(sessionId, payload) })
  const cancelWarm = state => {
    warmScheduler.cancel(state.sessionId)
    state.warmAbortController?.abort(new Error('cache warmer target replaced'))
    state.warmAbortController = null
    state.nextRefreshAt = null
    state.warming = false
  }

  const ensureState = sessionId => {
    let state = sessions.get(String(sessionId))
    if (!state) {
      state = statusState(String(sessionId))
      sessions.set(String(sessionId), state)
    }
    return state
  }
  const preferenceOf = sessionId => domain?.table('preferences').get(String(sessionId))?.enabled === true
  const setPreference = async (sessionId, enabled) => {
    if (!safeId(sessionId) || !domain) return false
    await domain.table('preferences').put(String(sessionId), { enabled })
    ensureState(sessionId).storageAvailable = true
    return true
  }
  const scheduleWarm = (session, state, now = Date.now()) => {
    if (state.warming) return
    const policy = selectedPolicy(state.provider, state.model)
    const at = policy && state.storageAvailable && state.lastRequestSnapshot
      && state.lastRequestFinished && isCurrentSnapshot(session, state.lastRequestSnapshot)
      ? policy.bestEffort
        ? nextBestEffortWarmAt(state, preferenceOf(session.id), settings, now)
        : nextWarmAt(state, preferenceOf(session.id), settings.activeMinutes, settings.idleMinutes, now) : null
    if (at === null) { warmScheduler.cancel(state.sessionId); state.nextRefreshAt = null; return }
    state.nextRefreshAt = at
    warmScheduler.schedule(state.sessionId, at, state.lastRequestSnapshot)
  }
  runScheduledWarm = async (sessionId, snapshot) => {
    if (disposed) return
    const session = ctx.sessions.get(sessionId)
    const state = sessions.get(sessionId)
    const policy = state && selectedPolicy(state.provider, state.model)
    if (!session || !state || !policy || state.warming || state.lastRequestSnapshot !== snapshot
      || !state.storageAvailable || !preferenceOf(sessionId)
      || !isCurrentSnapshot(session, snapshot)
      || requestWindowEnd(state, settings) <= Date.now()
      || state.warmAttemptCount >= 3 || state.warmFailureCount > 0) return
    const controller = new AbortController()
    state.warmAbortController = controller
    state.warming = true
    state.nextRefreshAt = null
    try {
      // Reserve worst-case uncached input conservatively for all three calls.
      const transport = await createBoundedOpenRouter(ctx, { maxInputBytes: inputBytesForBudget(settings.maxBudgetUsd) })
      state.warmAttemptCount += 1
      state.lastWarmAt = Date.now()
      const result = await runShadowWarm({ llm: transport, session, snapshot, policy,
        signal: controller.signal, timeoutMs: 10_000,
        isCurrent: () => !disposed && state.lastRequestSnapshot === snapshot
          && preferenceOf(sessionId) && requestWindowEnd(state, settings) > Date.now() })
      if (!result || controller.signal.aborted || state.lastRequestSnapshot !== snapshot) return
      if (result.reason?.kind !== 'stop' && result.reason?.kind !== 'max-tokens') throw new Error('shadow request incomplete')
      if (finiteNonNegative(result.usage?.cacheReadTokens) && result.usage.cacheReadTokens > 0) {
        state.lastCacheHitAt = Date.now()
        state.lastCacheHitTokens = result.usage.cacheReadTokens
        state.lastWarmCacheHitTokens = result.usage.cacheReadTokens
        state.warmFailureCount = 0
      } else throw new Error('shadow request had no cache hit')
    } catch (error) {
      if (!controller.signal.aborted && state.lastRequestSnapshot === snapshot) {
        state.warmFailureCount += 1
        // Stop on misses/errors rather than spending more on retries.
        state.warmError = String(error.message).startsWith('Bounded OpenRouter unavailable:')
          ? String(error.message) : 'Warm request failed or reported no cache hit; automatic retries stopped.'
      }
    } finally {
      if (state.warmAbortController === controller) {
        state.warmAbortController = null
        state.warming = false
        if (!controller.signal.aborted && state.warmFailureCount === 0) scheduleWarm(session, state)
      }
    }
  }
  const hydrateSession = session => {
    const state = ensureState(session.id)
    state.storageAvailable = domain !== undefined
    const latestContext = session.requestContext()
    const events = session.snapshotEvents(Math.max(0, state.lastEventSeq + 1))
    for (const event of events) {
      state.lastEventSeq = Math.max(state.lastEventSeq, event.seq)
      if (event.type === 'assistant/message') {
        const usage = event.data?.usage
        if (finiteNonNegative(usage?.cacheReadTokens) && usage.cacheReadTokens > 0) {
          if (event.seq > state.lastCacheHitEventSeq) {
            state.lastCacheHitTokens = usage.cacheReadTokens
            state.lastCacheHitAt = event.time
            state.lastCacheHitEventSeq = event.seq
          }
        }
      }
      if (event.type === 'request/header') {
        updateRoute(state, event.data?.header?.config?.provider ?? state.provider, event.data?.header?.config?.model ?? state.model)
      }
    }
    if (latestContext) updateRoute(state, latestContext.provider, latestContext.model)
    state.surfaceGeneration = session.surface.contentGeneration
    state.requestPrefix = requestFingerprint(session)
    return state
  }
  const getSession = sessionId => {
    if (!safeId(sessionId)) return undefined
    const session = ctx.sessions.get(sessionId)
    if (!session) return undefined
    return { session, state: hydrateSession(session) }
  }
  const makeStatus = sessionId => {
    const found = getSession(sessionId)
    if (!found) return {
      sessionId,
      enabled: false,
      route: null,
      model: null,
      supported: false,
      reason: 'Session is unavailable.',
      cacheTtlMs: null,
      cacheExpiresAt: null,
      lastCacheHitTokens: null,
      nextRefreshAt: null,
      windowEndsAt: null,
      phase: 'inactive',
      status: 'unavailable',
      warmingActive: false,
    }
    try { readOpenRouterRoute(ctx); found.state.transportAvailable = true } catch { found.state.transportAvailable = false }
    const enabled = preferenceOf(sessionId)
    return statusFor(found.state, settings, enabled, Date.now())
  }

  ctx.on('session/created', session => {
    const state = hydrateSession(session)
    newSessionIds.add(String(session.id))
    if (domain && domain.table('preferences').get(String(session.id)) === undefined) {
      void setPreference(session.id, settings.autoWarmNewChats).catch(() => {})
    }
    state.agentRunning = false
  })
  ctx.on('session/event', (session, event) => {
    const state = ensureState(session.id)
    if (event.type === 'request/header') {
      cancelWarm(state)
      updateRoute(state, event.data?.header?.config?.provider ?? state.provider, event.data?.header?.config?.model ?? state.model)
    } else if (event.type === 'request/context') {
      cancelWarm(state)
      updateRoute(state, event.data?.provider ?? state.provider, event.data?.model ?? state.model)
    } else if (event.type === 'assistant/message') {
      const usage = event.data?.usage
      if (finiteNonNegative(usage?.cacheReadTokens) && usage.cacheReadTokens > 0
        && event.seq > state.lastCacheHitEventSeq) {
        state.lastCacheHitAt = event.time
        state.lastCacheHitTokens = usage.cacheReadTokens
        state.lastCacheHitEventSeq = event.seq
      }
      if (state.lastRequestSnapshot && !event.data?.interrupted
        && event.data?.message?.source?.provider === state.provider
        && event.data?.message?.source?.model === state.model) {
        state.lastRequestFinished = true
        const policy = selectedPolicy(state.provider, state.model)
        if (policy && finiteNonNegative(usage?.cacheReadTokens) && usage.cacheReadTokens > 0)
          state.cacheTtlMs = policy.cacheTtlMs
        scheduleWarm(session, state)
      }
    } else if (event.type === 'turn/end') {
      if (event.data?.reason?.kind !== 'completed') cancelWarm(state)
      else { state.runEndedAt = Date.now(); state.agentRunning = false; scheduleWarm(session, state) }
    }
    state.surfaceGeneration = session.surface.contentGeneration
    state.requestPrefix = requestFingerprint(session)
  })
  ctx.on('session/disposed', session => {
    const state = sessions.get(String(session.id))
    if (state) cancelWarm(state)
    newSessionIds.delete(String(session.id))
    sessions.delete(String(session.id))
    agents.delete(String(session.id))
  })
  ctx.on('agent/created', ({ agent }) => {
    const state = ensureState(agent.id)
    const liveAgent = ctx.get('agents')?.get(agent.id)
    const session = ctx.get('sessions')?.get(agent.id)
    state.agentRunning = liveAgent?.status === 'running'
    if (session) hydrateSession(session)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    const state = ensureState(agent.id)
    const wasRunning = state.agentRunning
    state.agentRunning = status === 'running'
    if (status === 'running') {
      cancelWarm(state)
      state.runEndedAt = null
      agents.set(String(agent.id), agent)
    } else if (wasRunning) {
      state.runEndedAt = Date.now()
      const session = ctx.sessions.get(agent.id)
      if (session) scheduleWarm(session, state)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = ensureState(agent.id)
    if (state.agentRunning) state.runEndedAt = Date.now()
    state.agentRunning = false
    agents.delete(String(agent.id))
    const session = ctx.sessions.get(agent.id)
    if (session) scheduleWarm(session, state)
  })

  ctx.on('llm/stream', (options, next) => {
    // Hand-built, compaction/title, replay, and unrelated streams are not managed.
    if (!isAgentLoopRequest(options) || !safeId(options?.sessionId)) return next()
    const found = getSession(options.sessionId)
    if (!found) return next()
    const { state } = found
    // Any newer genuine dispatch cancels the previous target, even when the
    // current request cannot be matched to a committed header yet.
    cancelWarm(state)
    state.lastRequestSnapshot = null
    state.lastRequestFinished = false
    if (!isCurrentRequest(found.session, options)) return next()
    // Shadow attempts never enter this marked-request hook.
    state.lastRequestSnapshot = captureSessionSnapshot(found.session, options)
    state.lastRequestFinished = false
    state.cacheTtlMs = null
    state.warmFailureCount = 0
    state.warmAttemptCount = 0
    state.warmError = null
    state.lastWarmAt = null
    state.lastRequestAt = Date.now()
    updateRoute(state, options.provider, options.model)
    state.surfaceGeneration = found.session.surface.contentGeneration
    state.requestPrefix = requestFingerprint(found.session)
    const stream = next()
    return streamWithObserver(stream, chunk => {
      if (chunk?.type === 'usage' && finiteNonNegative(chunk.usage?.cacheReadTokens)
        && chunk.usage.cacheReadTokens > 0) {
        state.lastCacheHitAt = Date.now()
        state.lastCacheHitTokens = chunk.usage.cacheReadTokens
      }
    })
  }, { global: true })

  const registerRoutes = async () => {
    const unregister = await ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async request => {
        const url = new URL(request.url)
        if (request.method === 'GET') {
          return jsonResponse(url.searchParams.get('scope') === 'settings'
            ? globalSettings() : makeStatus(url.searchParams.get('sessionId')))
        }
        let body
        try { body = await request.json() } catch { return jsonResponse({ error: 'invalid-json' }, 400) }
        if (body?.scope === 'settings') {
          const next = { autoWarmNewChats: body.autoWarmNewChats,
            activeMinutes: body.activeMinutes, idleMinutes: body.idleMinutes, refreshMinutes: body.refreshMinutes ?? settings.refreshMinutes, maxBudgetUsd: body.maxBudgetUsd ?? settings.maxBudgetUsd }
          if (!Number.isFinite(next.maxBudgetUsd) || next.maxBudgetUsd < .05 || next.maxBudgetUsd > 10
            || !Number.isInteger(next.refreshMinutes) || next.refreshMinutes < 1 || next.refreshMinutes > 60
            || typeof next.autoWarmNewChats !== 'boolean'
            || ![next.activeMinutes, next.idleMinutes].every(value => Number.isInteger(value) && value >= 0 && value <= 1440)) {
            return jsonResponse({ error: 'invalid-settings' }, 400)
          }
          try { await saveGlobalSettings(next); return jsonResponse(next) }
          catch { return jsonResponse({ error: 'settings-save-failed' }, 503) }
        }
        const sessionId = body?.sessionId
        if (!safeId(sessionId) || typeof body?.enabled !== 'boolean') {
          return jsonResponse({ error: 'expected { sessionId, enabled }' }, 400)
        }
        if (!getSession(sessionId)) return jsonResponse({ error: 'session-unavailable' }, 404)
        if (!domain) return jsonResponse({ error: 'preferences-unavailable', ...makeStatus(sessionId) }, 503)
        try {
          await setPreference(sessionId, body.enabled)
          const state = sessions.get(String(sessionId))
          if (state) {
            if (!body.enabled) cancelWarm(state)
            else scheduleWarm(ctx.sessions.get(sessionId), state)
          }
          return jsonResponse(makeStatus(sessionId))
        } catch (error) {
          ctx.logger?.warn?.(`[dsh-cache-warmer] Preference update failed: ${String(error)}`)
          return jsonResponse({ error: 'preference-save-failed', ...makeStatus(sessionId) }, 503)
        }
      },
    })
    return unregister
  }

  const routeRegistration = registerRoutes()
  ctx.effect(() => {
    let active = true
    domainOpen = ctx.get('storageDomain')
      ? ctx.storageDomain.open(preferencesDomain).then(opened => {
        if (!active || disposed) return opened.close().then(() => undefined)
        domain = opened
        for (const session of ctx.sessions.list()) hydrateSession(session)
        for (const sessionId of newSessionIds) {
          if (opened.table('preferences').get(sessionId) === undefined) {
            void setPreference(sessionId, settings.autoWarmNewChats).catch(() => {})
          }
        }
        return opened
      }).catch(error => {
        ctx.logger?.warn?.(`[dsh-cache-warmer] Durable preference store unavailable; warming remains disabled: ${String(error)}`)
        return undefined
      })
      : Promise.resolve(undefined)
    return async () => {
      active = false
      disposed = true
      warmScheduler.dispose()
      for (const state of sessions.values()) cancelWarm(state)
      const unregister = await routeRegistration.catch(() => undefined)
      await unregister?.()
      await domainOpen
      await domain?.close()
      domain = undefined
      sessions.clear()
      agents.clear()
    }
  }, 'cache-warmer host lifecycle')
}
