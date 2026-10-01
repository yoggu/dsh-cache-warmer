import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const now = Date.now()
const base = { enabled: true, supported: true, warmingState: 'scheduled', reasonCode: 'ready',
  cacheTtlMs: 1800000, cacheExpiresAt: now + 1800000, nextRefreshAt: now + 1620000,
  ruleSource: 'codex-default', phase: 'active', status: 'running', lastCacheHitTokens: 184960,
  decision: { refreshCostUsd: .24, expectedSavingsUsd: 1.887, probability: 1, subscription: true } }
const textOf = node => typeof node === 'object' && node ? node.props.children.map(textOf).join(' ') : String(node ?? '')
const nodes = node => typeof node !== 'object' || !node ? [] : [node, ...node.props.children.flatMap(nodes)]

// Exercise the registered popup and its actual hooks/GET handler; no browser,
// private UI imports, real network requests, or timers are used.
function fixture({ status = base, locale = 'en', fail = false, observation } = {}) {
  const state = [], effects = [], pending = [], timers = new Set(), calls = { fetch: 0 }
  let cursor = 0, effectCursor = 0, plugin, component
  const projected = { current: observation }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) } }),
    useState: initial => {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useRef: initial => { const index = cursor++; return state[index] ||= { current: initial } },
    useEffect: (callback, deps) => {
      const index = effectCursor++, old = effects[index]
      if (old && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return
      pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: callback() } })
    },
    Fragment: 'fragment', useId: () => 'popup-help',
  }
  const noop = () => {}
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => { plugin = module.factory(name => name === 'react' ? React : { createPortal: node => node }) } }, addEventListener: noop, removeEventListener: noop },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild: noop }, body: {}, addEventListener: noop, removeEventListener: noop },
    ResizeObserver: class { observe() {} disconnect() {} }, AbortController,
    // No interval may exist: the popup re-reads on events only.
    setInterval: () => { throw new Error('the popup must not poll') }, clearInterval: () => {},
    setTimeout: callback => { timers.add(callback); return callback }, clearTimeout: callback => timers.delete(callback),
    fetch: async () => { calls.fetch += 1; if (fail) throw new Error('offline'); return { ok: true, json: async () => structuredClone(status) } },
  })
  const ctx = { locale: { getLocale: () => locale }, effect: callback => callback(), slots: {
    inject: (_key, register) => register(), register: (options, value) => { if (options.name === 'conversation.composer.dock') component = value },
  } }
  plugin.apply(ctx)
  const render = () => {
    cursor = 0; effectCursor = 0
    const node = component({ sessionId: 's', useProjection: () => projected.current }), tree = node.type(node.props)
    while (pending.length) pending.shift()()
    return tree
  }
  const all = () => nodes(render())
  render()
  all().find(node => node.type === 'button').props.onClick()
  const panel = () => all().find(node => node.props.role === 'dialog')
  return { panel, all, text: () => textOf(panel()), calls,
    byClass: name => all().find(node => node.props.className === name),
    toggle: () => all().find(node => node.type === 'button').props.onClick(),
    observe: value => { projected.current = value },
    flush: async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); return render() },
    // In-flight reads settle (and clear their own deadline) before the timer
    // check: unmount aborts them, so nothing may remain scheduled.
    unmount: async () => {
      effects.forEach(effect => effect.cleanup?.())
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
      assert.equal(timers.size, 0)
    },
  }
}

for (const locale of ['en', 'zh']) test(`popup title, status, description, checkbox, then compact info rows (${locale})`, async () => {
  const f = fixture({ locale, status: { ...base, warmingState: 'stopped', reasonCode: 'stopped' } })
  await f.flush()
  const panel = f.panel(), children = panel.props.children
  assert.equal(children[0].props.className, 'dsh-cache-warmer-header')
  assert.equal(children[0].props.style.display, 'flex')
  assert.equal(children[0].props.style.justifyContent, 'space-between')
  const [title, status] = children[0].props.children
  assert.equal(title.type, 'h3')
  assert.equal(textOf(title), locale === 'zh' ? '缓存保温' : 'Cache warming')
  assert.equal(panel.props['aria-label'], textOf(title))
  assert.equal(status.props.className, 'dsh-cache-warmer-state')
  assert.equal(status.props.style.flexShrink, 0)
  assert.equal(children[1].props.className, 'dsh-cache-warmer-description')
  assert.equal(children[0].props.style.marginBottom, 4)
  assert.equal(children[1].props.style.lineHeight, '20px')
  assert.equal(children[1].props.style.fontSize, 12)
  assert.equal(children[1].props.style.marginBottom, 12)
  assert.equal(children[1].props.style.color, 'var(--dsw-alias-label-secondary)')
  assert.doesNotMatch(f.text(), /guaranteed output cap|输出令牌上限/)
  assert.match(f.text(), locale === 'zh' ? /保温会消耗用量。/ : /Warming consumes usage\./)
  assert.equal(children[2].type, 'label', 'checkbox comes before every info row')
  assert.equal(children[2].props.children[0].props.type, 'checkbox')
  assert.equal(children[3].props['aria-hidden'], true, 'divider separates controls from information')
  assert.equal(textOf(children[4]), locale === 'zh' ? '剩余时间 ~30 分钟' : 'Time remaining ~30 min')
  assert.equal(textOf(children[5]), locale === 'zh' ? '缓存有效期 30 分钟' : 'Cache lifetime 30 min')
  assert.doesNotMatch(f.text(), /Phase|阶段|Codex default|Codex 默认|Context cache|Estimated cache time remaining:/)
  assert.match(f.text(), locale === 'zh' ? /预计刷新费用 \$0.240/ : /Estimated refresh cost \$0.240/)
  assert.match(f.text(), locale === 'zh' ? /预计净收益 \$1.887/ : /Expected net benefit \$1.887/)
  await f.unmount()
})

const cases = [
  ['scheduled', 'ready', 'Scheduled', '已安排', 'Conditions are checked again before sending.'],
  ['warming', 'warming', 'Warming', '保温中', 'A background request is refreshing the cache.'],
  ['waiting', 'request-in-flight', 'Waiting', '等待中', 'Waiting for the current request to finish.'],
  ['skipped', 'insufficient-savings', 'Skipped', '已跳过', 'Expected savings are too low.'],
  ['stopped', 'stopped', 'Stopped', '已停止', 'Warming stopped after an error, miss, cancellation or context change.'],
  ['disabled', 'policy-disabled', 'Disabled', '已停用', 'The model cache policy disables warming.'],
  ['unavailable', 'unknown-lifetime', 'Unavailable', '不可用', 'No cache lifetime estimate is configured; observation only.'],
]
for (const locale of ['en', 'zh']) test(`seven simple states with separate nonmonetary descriptions (${locale})`, async () => {
  for (const [warmingState, reasonCode, en, zh, description] of cases) {
    const f = fixture({ locale, status: { ...base, warmingState, reasonCode } })
    await f.flush()
    assert.equal(textOf(f.byClass('dsh-cache-warmer-state')), locale === 'zh' ? zh : en)
    const explanation = textOf(f.byClass('dsh-cache-warmer-description'))
    if (locale === 'en') assert.equal(explanation, description)
    else assert.match(explanation, /[\u4e00-\u9fff]/)
    assert.doesNotMatch(explanation, /\$|0\.05|0\.050|—|Note:/)
    assert.doesNotMatch(textOf(f.byClass('dsh-cache-warmer-state')), /[:：]/)
    await f.unmount()
  }
})

test('old host needs an actual future timer; loading and failed polling never claim scheduling', async () => {
  const { warmingState: _state, ...legacy } = base
  for (const [status, expected] of [
    [{ ...legacy, nextRefreshAt: null }, 'Waiting'], [legacy, 'Scheduled'],
    [{ ...legacy, warming: true }, 'Warming'],
    [{ ...legacy, reasonCode: 'window-too-short' }, 'Stopped'],
    [{ ...legacy, reasonCode: 'transport-pending', nextRefreshAt: null }, 'Waiting'],
  ]) {
    const f = fixture({ status })
    assert.equal(textOf(f.byClass('dsh-cache-warmer-state')), 'Unavailable')
    await f.flush()
    assert.equal(textOf(f.byClass('dsh-cache-warmer-state')), expected)
    if (status.reasonCode === 'transport-pending') assert.match(textOf(f.byClass('dsh-cache-warmer-description')), /previous background request/)
    await f.unmount()
  }
  const f = fixture({ fail: true })
  await f.flush()
  assert.equal(textOf(f.byClass('dsh-cache-warmer-state')), 'Unavailable')
  assert.match(textOf(f.byClass('dsh-cache-warmer-description')), /Could not load/)
  await f.unmount()
})

test('native client-bounded status explains separate consent and uncertain provider-side usage', async () => {
  const f = fixture({ status: { ...base, outputBound: 'client', warmingState: 'disabled', reasonCode: 'client-bound-opt-in-required' } })
  await f.flush()
  assert.equal(textOf(f.byClass('dsh-cache-warmer-state')), 'Disabled')
  assert.match(f.text(), /Enable best-effort warming in plugin settings/)
  assert.match(f.text(), /no guaranteed server-side output cap/)
  assert.match(f.text(), /Hidden reasoning and generation after client cancellation may still consume usage/)
  assert.match(f.text(), /Cache lifetime 30 min/)
  await f.unmount()
})

test('unsupported native request explains the exact safe-thinking gate without hiding the countdown', async () => {
  const f = fixture({ status: { ...base, supported: false, warmingState: 'unavailable', reasonCode: 'unsupported', transportReasonCode: 'unsafe-thinking-budget' } })
  await f.flush()
  assert.equal(textOf(f.byClass('dsh-cache-warmer-state')), 'Unavailable')
  assert.match(f.text(), /Preserving this request’s native thinking budget would exceed the safe refresh output cap/)
  assert.match(f.text(), /Cache lifetime 30 min/)
  await f.unmount()
})

test('unknown and elapsed cache estimates retain compact rows without fabricated lifetimes', async () => {
  for (const [status, remaining, lifetime] of [
    [{ ...base, cacheTtlMs: null, cacheExpiresAt: null }, 'Unknown', 'Unknown'],
    [{ ...base, cacheExpiresAt: now - 1 }, 'Elapsed', '30 min'],
  ]) {
    const f = fixture({ status }); await f.flush()
    assert.equal(textOf(f.panel().props.children[4]), `Time remaining ${remaining}`)
    assert.equal(textOf(f.panel().props.children[5]), `Cache lifetime ${lifetime}`)
    await f.unmount()
  }
})

test('the popup re-reads the host status on durable observations, never on a timer', async () => {
  const f = fixture()
  await f.flush()
  // Mount reads once, and the fixture's open click is a user read.
  const opened = f.calls.fetch
  assert.equal(opened, 2)
  // The first defined value is the follow baseline and needs no second read.
  f.observe({ provider: 'openrouter', model: 'm', usageAt: 2, lastCacheHitAt: 2, lastCacheHitTokens: 20 })
  await f.flush()
  assert.equal(f.calls.fetch, opened, 'a baseline needs no second read')
  f.observe({ provider: 'openrouter', model: 'm', usageAt: 3, lastCacheHitAt: 3, lastCacheHitTokens: 30 })
  await f.flush()
  assert.equal(f.calls.fetch, opened + 1, 'a new durable observation re-reads the status')
  f.observe(undefined)
  await f.flush()
  assert.equal(f.calls.fetch, opened + 1, 'an absent projection is not an event')
  await f.unmount()
})

test('the countdown runs on the local clock without reading the host again', async () => {
  const f = fixture({ status: { ...base, cacheExpiresAt: Date.now() + 90000 } })
  await f.flush()
  const opened = f.calls.fetch
  const rows = f.panel().props.children
  assert.equal(textOf(rows[4]), 'Time remaining ~2 min', 'the countdown comes from the local clock')
  assert.equal(textOf(rows[5]), 'Cache lifetime 30 min')
  assert.equal(f.calls.fetch, opened, 'the countdown issues no request')
  await f.unmount()
})

test('a closed popup costs nothing while the session keeps working', async () => {
  const f = fixture()
  await f.flush()
  const opened = f.calls.fetch
  f.toggle()
  await f.flush()
  f.observe({ provider: 'openrouter', model: 'm', usageAt: 9, lastCacheHitAt: 9, lastCacheHitTokens: 9 })
  await f.flush()
  f.observe({ provider: 'openrouter', model: 'm', usageAt: 10, lastCacheHitAt: 10, lastCacheHitTokens: 10 })
  await f.flush()
  assert.equal(f.calls.fetch, opened, 'a durable observation is not read while the popup is closed')
  f.toggle()
  await f.flush()
  assert.equal(f.calls.fetch, opened + 1, 'reopening is a user read')
  await f.unmount()
})
