import Schema from '@deepseek-ai/schemastery'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { createBoundedOpenRouter, readOpenRouterRoute } from './openrouter.js'
import { createCodexTransport, readCodexRoute } from './codex.js'
import { policyFor, nonnegative, createCatalogReader, warmingDecision, usageCost, windowEnd, nextDecisionAt } from './policy.js'
import { observations } from './observations.js'

export const name = 'dsh-cache-warmer'
export const inject = ['llm', 'connection', 'sessions', 'sessionProjections', 'storageDomain', 'configEditor', 'settings', 'credentials']
export const Config = Schema.object({
  autoWarmNewChats: Schema.boolean().default(false),
  activeMinutes: Schema.number().min(0).max(1440).default(60),
  idleMinutes: Schema.number().min(0).max(1440).default(30),
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

export function isCurrentRequest(session, options) {
  if (!session || !isAgentLoopRequest(options) || options.sessionId !== session.id) return false
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
  // The Codex transport appends its small request, using native projection/auth.
  // Do not pretend that maxTokens is a hard bound for that transport.
  if (policy.kind === 'openrouter') options.maxTokens = policy.maxOutputTokens
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

export function updateRoute(state, provider, model) {
  if (state.provider !== provider || state.model !== model) {
    state.lastCacheHitAt = null; state.lastCacheHitTokens = null; state.lastWarmAt = null
    state.lastWarmCacheHitTokens = null; state.usage = null
  }
  state.provider = provider; state.model = model
  state.cacheTtlMs = policyFor(provider, model)?.cacheTtlMs ?? null
}
export function cacheExpiryAt(state) {
  return nonnegative(state?.lastCacheHitAt) && nonnegative(state?.cacheTtlMs) && state.cacheTtlMs > 0
    ? state.lastCacheHitAt + state.cacheTtlMs : null
}
const REASONS = {
  unsupported: 'No compatible warming transport for this route.',
  'unknown-lifetime': 'No reviewed cache-lifetime estimate is available for this model.',
  'unknown-pricing': 'Model pricing is unavailable; no automatic warming request will be sent.',
  'no-cache-evidence': 'Waiting for a genuine request to report reusable cached tokens.',
  'no-context': 'Waiting for a new completed request to capture the current context.',
  disabled: 'Warming is not enabled for this session.',
  'window-ended': 'The configured window from the last real model request has ended.',
  'insufficient-savings': 'Estimated benefit is below the $0.05 threshold; refresh skipped.',
  'cache-elapsed': 'The estimated cache lifetime has elapsed; waiting for a real request.',
  stopped: 'Warming stopped after an error, cache miss, cancellation, or context change.',
  'no-storage': 'Durable preferences or usage accounting are unavailable; warming is disabled.',
  ready: '',
}

export function statusFor(state, config, enabled, now = Date.now()) {
  const policy = policyFor(state.provider, state.model)
  const supported = Boolean(policy && state.transportAvailable)
  const windowEndsAt = windowEnd(state, config)
  let code = 'ready'
  if (!supported) code = 'unsupported'
  else if (!policy.cacheTtlMs && !policy.decisionIntervalMs) code = 'unknown-lifetime'
  else if (!state.storageAvailable) code = 'no-storage'
  else if (!enabled) code = 'disabled'
  else if (state.warmFailureCount || state.warmError) code = 'stopped'
  else if (!state.lastRequestSnapshot || !state.lastRequestFinished) code = 'no-context'
  else if (windowEndsAt === null || now >= windowEndsAt) code = 'window-ended'
  else if (cacheExpiryAt(state) !== null && now >= cacheExpiryAt(state)) code = 'cache-elapsed'
  else if (state.decision && !state.decision.worthwhile) code = state.decision.reason
  return { sessionId: state.sessionId, enabled, supported, reasonCode: code, reason: code === 'unsupported' && state.transportReason ? state.transportReason : REASONS[code] ?? '',
    route: state.provider && state.model ? `${state.provider}/${state.model}` : null, model: state.model,
    cacheTtlMs: state.cacheTtlMs, cacheExpiresAt: cacheExpiryAt(state), cacheEstimated: true,
    cacheEstimateSource: policy?.cacheEstimateSource ?? null,
    lastCacheHitAt: state.lastCacheHitAt, lastCacheHitTokens: state.lastCacheHitTokens,
    lastWarmAt: state.lastWarmAt, lastWarmCacheHitTokens: state.lastWarmCacheHitTokens,
    warmAttemptCount: state.warmAttemptCount, decision: state.decision,
    nextRefreshAt: supported && enabled && code === 'ready' ? state.nextRefreshAt : null,
    windowEndsAt, phase: state.agentRunning ? 'active' : state.runEndedAt !== null ? 'idle' : 'inactive',
    status: state.agentRunning ? 'running' : state.runEndedAt !== null ? 'idle' : 'inactive',
    warmingActive: code === 'ready' && enabled && Boolean(state.nextRefreshAt || state.warming) }
}

export function apply(ctx, config = {}) {
  const settings = { autoWarmNewChats: config.autoWarmNewChats === true,
    activeMinutes: nonnegative(config.activeMinutes) ? Math.min(1440, config.activeMinutes) : 60,
    idleMinutes: nonnegative(config.idleMinutes) ? Math.min(1440, config.idleMinutes) : 30 }
  const sessions = new Map(), newSessions = new Set(), runningWork = new Set()
  const catalog = createCatalogReader()
  let preferences, accounting, disposed = false, storageHealthy = true
  ctx.sessionProjections.register(observations)
  const stateOf = id => {
    id = String(id)
    if (!sessions.has(id)) sessions.set(id, { sessionId: id, provider: null, model: null,
      lastCacheHitAt: null, lastCacheHitTokens: null, cacheTtlMs: null, usage: null, observedAt: null,
      lastRequestAt: null, lastRequestSnapshot: null, lastRequestFinished: false, routeIdentity: null,
      runEndedAt: null, agentRunning: false, lastWarmAt: null, lastWarmCacheHitTokens: null,
      nextRefreshAt: null, warming: false, transportPending: false, warmAbortController: null, warmFailureCount: 0,
      warmAttemptCount: 0, warmError: null, decision: null, decisionStopped: false,
      observedWarmOutput: 0, transportAvailable: false, storageAvailable: false })
    return sessions.get(id)
  }
  const enabled = id => preferences?.table('preferences').get(String(id))?.enabled === true
  const routeIdentity = state => JSON.stringify(state.provider === 'openrouter'
    ? readOpenRouterRoute(ctx) : readCodexRoute(ctx, state.provider, state.model))
  const refreshTransport = state => {
    try {
      state.transportAvailable = Boolean(policyFor(state.provider, state.model)); state.transportReason = null
      if (state.transportAvailable) routeIdentity(state)
    } catch (error) {
      state.transportAvailable = false
      // Only our transport's fixed, non-secret availability diagnostics may escape.
      state.transportReason = /^(Codex warming unavailable|Bounded OpenRouter unavailable): /.test(error?.message ?? '') ? error.message : null
    }
  }
  const hydrate = session => {
    const state = stateOf(session.id)
    const value = ctx.sessionProjections.stateOf(session, observations.key)
    if (value) {
      updateRoute(state, value.provider, value.model)
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
  const decisionFor = state => warmingDecision({ usage: state.usage, cost: catalog(state.provider, state.model),
    policy: policyFor(state.provider, state.model), active: state.agentRunning, observedWarmOutput: state.observedWarmOutput })
  const cancel = (state, invalidate = false) => {
    scheduler.cancel(state.sessionId)
    state.warmAbortController?.abort(new Error('cache warmer cancelled'))
    state.nextRefreshAt = null
    // Keep warming true until the old task unwinds: never overlap calls.
    if (invalidate) { state.lastRequestSnapshot = null; state.lastRequestFinished = false }
  }
  const schedule = (session, state) => {
    if (disposed || state.warming || state.transportPending || !storageHealthy) return
    scheduler.cancel(state.sessionId); state.nextRefreshAt = null
    state.decision = decisionFor(state)
    const policy = policyFor(state.provider, state.model)
    if (!policy || !state.storageAvailable || !state.transportAvailable || !state.lastRequestFinished
      || !isCurrentSnapshot(session, state.lastRequestSnapshot)) return
    try { if (state.routeIdentity !== routeIdentity(state)) { cancel(state, true); return } } catch { cancel(state, true); return }
    const at = nextDecisionAt(state, enabled(session.id), settings, policy)
    // A failed economics test stays stopped for this phase until a real request.
    if (at === null || !state.decision.worthwhile) return
    state.nextRefreshAt = at
    scheduler.schedule(state.sessionId, at, state.lastRequestSnapshot)
  }
  const persistUsage = async (state, usage, completed, attempted = true) => {
    if (!accounting) return
    const table = accounting.table('summaries')
    const previous = table.get(state.sessionId) ?? { attempts: 0, completed: 0, usd: 0, unpriced: 0,
      subscription: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, lastAt: 0 }
    const usd = usage ? usageCost(usage, catalog(state.provider, state.model)) : null
    await table.put(state.sessionId, { attempts: previous.attempts + Number(attempted),
      completed: previous.completed + Number(completed), usd: previous.usd + (usd ?? 0),
      unpriced: previous.unpriced + Number(usd === null), subscription: previous.subscription || policyFor(state.provider, state.model)?.subscription === true,
      inputTokens: previous.inputTokens + (nonnegative(usage?.inputTokens) ? usage.inputTokens : 0),
      outputTokens: previous.outputTokens + (nonnegative(usage?.outputTokens) ? usage.outputTokens : 0),
      cacheReadTokens: previous.cacheReadTokens + (nonnegative(usage?.cacheReadTokens) ? usage.cacheReadTokens : 0), lastAt: Date.now() })
  }
  const run = async (sessionId, snapshot) => {
    const session = ctx.sessions.get(sessionId), state = sessions.get(sessionId)
    const policy = state && policyFor(state.provider, state.model)
    if (!session || !state || !policy || disposed || state.warming || state.transportPending || !storageHealthy || !state.storageAvailable
      || !enabled(sessionId) || snapshot !== state.lastRequestSnapshot || !isCurrentSnapshot(session, snapshot)) return
    state.nextRefreshAt = null
    state.decision = decisionFor(state)
    if (nextDecisionAt(state, true, settings, policy) === null || !state.decision.worthwhile) return
    const controller = new AbortController()
    state.warmAbortController = controller; state.warming = true
    const deadline = setTimeout(() => controller.abort(new Error('cache warmer deadline')),
      Math.max(1, Math.min(10_000, windowEnd(state, settings) - Date.now())))
    let usage, attempted = false, completed = false
    const accountingTarget = { sessionId, provider: state.provider, model: state.model }
    const current = () => {
      if (disposed || controller.signal.aborted || !enabled(sessionId) || state.lastRequestSnapshot !== snapshot
        || !isCurrentSnapshot(session, snapshot) || Date.now() >= windowEnd(state, settings)) return false
      try { return state.routeIdentity === routeIdentity(state) } catch { return false }
    }
    try {
      if (!current()) return
      const transport = policy.kind === 'codex'
        ? await createCodexTransport(ctx, { provider: state.provider, model: state.model })
        : await createBoundedOpenRouter(ctx)
      if (!current()) return
      attempted = true; state.warmAttemptCount++
      const result = await runShadowWarm({ llm: transport, session, snapshot, policy, signal: controller.signal,
        isCurrent: current, onUsage: value => { usage = value },
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
        state.lastRequestFinished = true
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
    for (const state of sessions.values()) {
      cancel(state, true)
      state.lastCacheHitAt = null; state.lastCacheHitTokens = null
      state.usage = null; state.evidenceInvalidated = true
    }
  }
  ctx.on('settings/document-updated', invalidateRoutes)
  ctx.on('llm/adapters-updated', invalidateRoutes)
  ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options) || !safeId(options.sessionId)) return next()
    const session = ctx.sessions.get(options.sessionId)
    if (!session) return next()
    const state = hydrate(session)
    cancel(state, true)
    if (!isCurrentRequest(session, options) || session.header?.origin === 'subagent') return next()
    updateRoute(state, options.provider, options.model)
    try { state.routeIdentity = routeIdentity(state) } catch { state.routeIdentity = null }
    state.lastRequestSnapshot = captureSessionSnapshot(session, options)
    state.lastRequestAt = Date.now(); state.lastWarmAt = null; state.warmFailureCount = 0
    state.warmAttemptCount = 0; state.warmError = null; state.decisionStopped = false; state.decision = null
    return next()
  }, { global: true })

  const makeStatus = id => {
    const session = safeId(id) && ctx.sessions.get(id)
    if (!session) return { sessionId: id, enabled: false, supported: false, status: 'unavailable',
      reason: 'Session is unavailable.', reasonCode: 'no-context', cacheTtlMs: null, cacheExpiresAt: null }
    const state = hydrate(session)
    state.decision = decisionFor(state)
    return { ...statusFor(state, settings, enabled(id)), warmUsage: accounting?.table('summaries').get(String(id)) ?? null }
  }
  const routeRegistration = ctx.connection.fetch.register({ path: ROUTE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async request => {
      const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
      const url = new URL(request.url)
      if (request.method === 'GET') return json(url.searchParams.get('scope') === 'settings' ? settings : makeStatus(url.searchParams.get('sessionId')))
      let body
      try { body = await request.json() } catch { return json({ error: 'invalid-json' }, 400) }
      if (body?.scope === 'settings') {
        const next = { autoWarmNewChats: body.autoWarmNewChats, activeMinutes: body.activeMinutes, idleMinutes: body.idleMinutes }
        if (typeof next.autoWarmNewChats !== 'boolean' || ![next.activeMinutes, next.idleMinutes].every(v => Number.isInteger(v) && v >= 0 && v <= 1440)) return json({ error: 'invalid-settings' }, 400)
        const entry = ctx.configEditor.entries().find(e => e.options?.name === name && e.options?.id === name)
        if (!entry) return json({ error: 'settings-unavailable' }, 503)
        try {
          // Also discard legacy refresh/budget values when the user next saves.
          await ctx.configEditor.edit(entry, () => next)
          return json(next)
        } catch { return json({ error: 'settings-save-failed' }, 503) }
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
    disposed = true; scheduler.dispose()
    for (const state of sessions.values()) cancel(state, true)
    await Promise.allSettled([...runningWork])
    const unregister = await Promise.resolve(routeRegistration).catch(() => null)
    await unregister?.(); await opened
    await preferences?.close(); await accounting?.close()
    sessions.clear()
  }, 'cache-warmer lifecycle')
}
