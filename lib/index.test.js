import test from 'node:test'
import assert from 'node:assert/strict'
import {
  admitWarmRoute,
  cacheExpiryAt,
  captureSessionSnapshot,
  consumeShadowStream,
  createShadowRequest,
  createWarmScheduler,
  isCurrentSnapshot,
  nextWarmAt,
  warmBackoffMs,
  updateRoute,
  statusFor,
  nextBestEffortWarmAt,
  runShadowWarm,
} from './index.js'

const verifiedPolicy = {
  provider: 'example',
  model: 'bounded-model',
  wireVerified: true,
  cacheSemanticsVerified: true,
  wireMaxTokensField: 'max_completion_tokens',
  maxOutputTokens: 7,
  cacheTtlMs: 300_000,
}

function sessionFixture() {
  const messages = [{ role: 'user', content: 'short synthetic input' }]
  const header = { config: { provider: 'example', model: 'bounded-model', temperature: 0.2, maxTokens: 100 }, tools: [{ name: 'lookup' }], adapterDefaults: {} }
  return {
    id: 'session-test',
    requestHeader: () => header,
    toolHistory: () => ({ tools: header.tools, updates: [] }),
    deriveMessages: () => messages,
    surface: { nodes: [1], contentGeneration: 1, replaceGeneration: 0 },
    _messages: messages,
  }
}

test('route changes invalidate cache evidence, not same-route observations', () => {
  const state = { provider: 'codex', model: 'a', lastCacheHitAt: 100, lastCacheHitTokens: 200, cacheTtlMs: null }
  updateRoute(state, 'codex', 'a')
  assert.equal(state.lastCacheHitAt, 100)
  updateRoute(state, 'openrouter', 'b')
  assert.equal(state.lastCacheHitAt, null)
  assert.equal(state.lastCacheHitTokens, null)
})

test('status distinguishes last hit from expiry and refresh interval', () => {
  const state = { sessionId: 's', provider: 'codex', model: 'a', agentRunning: false, runEndedAt: 1, lastCacheHitAt: 100, lastCacheHitTokens: 200, cacheTtlMs: null }
  const status = statusFor(state, { activeMinutes: 60, idleMinutes: 30, refreshMinutes: 5 }, false, 1000)
  assert.equal(status.lastCacheHitAt, 100)
  assert.equal(status.cacheExpiresAt, null)
  assert.equal(status.refreshIntervalMs, 300000)
  assert.equal(status.reasonCode, 'codex-unbounded')
  assert.equal(status.supported, false)
})

const chunkStream = chunks => (async function* () { for (const chunk of chunks) yield chunk })()

test('route admission is exact, bounded, and requires explicit wire/cache evidence', () => {
  assert.equal(admitWarmRoute('example', 'bounded-model'), false)
  assert.equal(admitWarmRoute('example', 'bounded-model', [verifiedPolicy]), true)
  assert.equal(admitWarmRoute('another', 'bounded-model', [verifiedPolicy]), false)
  assert.equal(admitWarmRoute('example', 'bounded-model', [{ ...verifiedPolicy, cacheTtlMs: null }]), false)
  assert.equal(admitWarmRoute('example', 'bounded-model', [{ ...verifiedPolicy, maxOutputTokens: 33 }]), false)
  assert.equal(admitWarmRoute('example', 'bounded-model', [{ ...verifiedPolicy, wireVerified: false }]), false)
})

test('cache expiry stays unknown until both hit time and positive TTL are known', () => {
  assert.equal(cacheExpiryAt({ lastCacheHitAt: 123, cacheTtlMs: null }), null)
  assert.equal(cacheExpiryAt({ lastCacheHitAt: null, cacheTtlMs: 1000 }), null)
  assert.equal(cacheExpiryAt({ lastCacheHitAt: 123, cacheTtlMs: 0 }), null)
  assert.equal(cacheExpiryAt({ lastCacheHitAt: 123, cacheTtlMs: 1000 }), 1123)
})

test('snapshot allows one matching assistant completion but rejects stale/replaced surface', () => {
  const session = sessionFixture()
  const options = { provider: 'example', model: 'bounded-model', messages: session.deriveMessages(), tools: [{ name: 'lookup' }], toolHistory: session.toolHistory(), maxTokens: 100 }
  const snapshot = captureSessionSnapshot(session, options)
  assert.ok(snapshot)
  assert.equal(isCurrentSnapshot(session, snapshot), true)
  session._messages.push({ role: 'assistant', source: { provider: 'example', model: 'bounded-model' }, content: 'ok' })
  session.surface.nodes.push(2)
  session.surface.contentGeneration += 1
  assert.equal(isCurrentSnapshot(session, snapshot), true)
  session._messages.push({ role: 'user', content: 'new input' })
  session.surface.nodes.push(3)
  session.surface.contentGeneration += 1
  assert.equal(isCurrentSnapshot(session, snapshot), false)
  session.surface.replaceGeneration += 1
  assert.equal(isCurrentSnapshot(session, snapshot), false)
})

test('shadow request preserves cache-identity envelope and replaces only bounded output/signal', () => {
  const session = sessionFixture()
  const options = { ...session.requestHeader().config, messages: session.deriveMessages(), toolHistory: session.toolHistory(), tools: session.requestHeader().tools, system: 'fixed', sessionId: session.id }
  const snapshot = captureSessionSnapshot(session, options)
  const controller = new AbortController()
  const shadow = createShadowRequest(session, snapshot, verifiedPolicy, controller.signal)
  assert.ok(shadow)
  assert.equal(shadow.system, 'fixed')
  assert.deepEqual(shadow.tools, options.tools)
  assert.deepEqual(shadow.toolHistory, options.toolHistory)
  assert.equal(shadow.maxTokens, 7)
  assert.equal(shadow.signal, controller.signal)
  assert.equal(createShadowRequest(session, snapshot, { ...verifiedPolicy, provider: 'bad' }, controller.signal), null)
})

test('bounded shadow call consumes cache usage without dispatching tools or modifying session', async () => {
  const session = sessionFixture()
  const snapshot = captureSessionSnapshot(session, {...session.requestHeader().config, messages:session.deriveMessages(), tools:session.requestHeader().tools})
  const before = JSON.stringify(session._messages)
  let count = 0
  const result = await runShadowWarm({session,snapshot,policy:verifiedPolicy,llm:{stream(options){
    count++; assert.equal(options.maxTokens,7)
    return chunkStream([{type:'tool-call-delta',id:'ignored',name:'lookup',argumentsDelta:'{}'}, {type:'usage',usage:{cacheReadTokens:1152}}, {type:'finish',reason:{kind:'max-tokens'}}])
  }}})
  assert.equal(result.usage.cacheReadTokens,1152)
  assert.equal(count,1)
  assert.equal(JSON.stringify(session._messages),before)
})

test('scheduler cancels replaced work and tears down outstanding timers', async () => {
  let now = 100
  let nextTimer = 0
  const timers = new Map()
  const calls = []
  const scheduler = createWarmScheduler({
    now: () => now,
    setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id },
    clearTimer: id => timers.delete(id),
    run: async (key, payload) => calls.push([key, payload]),
  })
  scheduler.schedule('s', 500, 'old')
  scheduler.schedule('s', 300, 'new')
  assert.equal(scheduler.size(), 1)
  assert.equal([...timers.values()][0].ms, 200)
  now = 300
  const [timer] = timers.values()
  timers.clear()
  timer.fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [['s', 'new']])
  scheduler.schedule('s', 400, 'disposed')
  scheduler.dispose()
  assert.equal(scheduler.size(), 0)
  assert.equal(timers.size, 0)
})

test('best effort cadence does not fabricate TTL and respects budgets and circuit breaker', () => {
  const state = { lastRequestAt: 1000, runEndedAt: 1000, agentRunning: false, warmAttemptCount: 0, warmFailureCount: 0 }
  const config = { activeMinutes: 60, idleMinutes: 30, refreshMinutes: 5 }
  assert.equal(nextBestEffortWarmAt(state, true, config, 2000), 301000)
  assert.equal(nextBestEffortWarmAt({...state, warmAttemptCount:3}, true, config, 2000), null)
  assert.equal(nextBestEffortWarmAt({...state, warmFailureCount:1}, true, config, 2000), null)
  assert.equal(nextBestEffortWarmAt(state, false, config, 2000), null)
  assert.equal(nextBestEffortWarmAt(state, true, {...config,idleMinutes:0}, 2000), null)
  assert.equal(cacheExpiryAt(state), null)
  assert.equal(admitWarmRoute('openrouter', '~deepseek/deepseek-v4-flash-latest'), true)
})

test('next refresh requires known TTL and remaining session window', () => {
  const base = { cacheTtlMs: 300_000, lastCacheHitAt: 1000, agentRunning: true, lastRequestAt: 1000 }
  assert.equal(nextWarmAt({ ...base, cacheTtlMs: null }, true, 60, 30, 10_000), null)
  assert.equal(nextWarmAt(base, false, 60, 30, 10_000), null)
  assert.equal(nextWarmAt(base, true, 60, 30, 10_000), 271_000)
  assert.equal(nextWarmAt({ ...base, lastRequestAt: 0 }, true, 0, 30, 10_000), null)
})

test('backoff is exponential and capped', () => {
  assert.equal(warmBackoffMs(0, { initialBackoffMs: 500, maxBackoffMs: 2000 }), 500)
  assert.equal(warmBackoffMs(1, { initialBackoffMs: 500, maxBackoffMs: 2000 }), 1000)
  assert.equal(warmBackoffMs(8, { initialBackoffMs: 500, maxBackoffMs: 2000 }), 2000)
})

test('shadow stream records usage, preserves abort signal, and enforces timeout cancellation', async () => {
  const controller = new AbortController()
  const result = await consumeShadowStream(chunkStream([
    { type: 'usage', usage: { cacheReadTokens: 12 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), { controller, timeoutMs: 1000 })
  assert.equal(result.usage.cacheReadTokens, 12)
  assert.equal(controller.signal.aborted, true)

  const timedController = new AbortController()
  await assert.rejects(consumeShadowStream((async function* () { await new Promise(() => {}) })(), {
    controller: timedController,
    timeoutMs: 5,
  }), /timeout/)
  assert.equal(timedController.signal.aborted, true)
})
