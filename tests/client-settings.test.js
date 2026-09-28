import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const model = (id, overrides = {}) => ({ id, name: id, defaultCacheMinutes: null, transportSupported: true, reasonCode: null, ...overrides })
const provider = (id, models, overrides = {}) => ({ id, name: id, models, ...overrides })
const policy = (provider, model, cacheMinutes, enabled = false) => ({ provider, model, enabled, cacheMinutes })
const base = { autoWarmNewChats: false, activeMinutes: 60, idleMinutes: 30, useCodexDefaults: true,
  minExpectedBenefitUsd: 0.05, idleContinuationPercent: 15, modelPolicies: [] }
const codex = { providers: [provider('codex-business', [model('gpt-5', { name: 'GPT 5', defaultCacheMinutes: 30 })])] }
const openrouter = { providers: [provider('openrouter', [model('deepseek/flash')])] }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

// Run real component hooks/effects and request handlers in a VM, without importing
// private UI packages, accessing the browser, or issuing any network requests.
function fixture({ locale = 'en', settings = base, models = openrouter } = {}) {
  const state = [], effects = [], pending = [], posts = [], requests = [], registrations = [], styles = []
  let cursor = 0, effectCursor = 0, plugin, component, clock = 0, timerId = 0
  const timers = new Map()
  let settingsResponse = settings, modelsResponse = models, postResponse
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) } }),
    useState: initial => {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useEffect: (callback, deps) => {
      const index = effectCursor++, old = effects[index]
      if (old && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return
      pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: callback() } })
    },
    Fragment: 'fragment', useId: () => 'settings-help',
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => { plugin = module.factory(name => name === 'react' ? React : {}) } } },
    AbortController,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { at: clock + delay, callback }); return id },
    clearTimeout: id => timers.delete(id),
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild: style => styles.push(style.textContent) } },
    fetch: async (url, options = {}) => {
      requests.push({ url, options })
      let response
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        posts.push(body)
        response = postResponse === undefined ? { ...body } : postResponse
        if (postResponse === undefined) delete response.scope
      } else response = url.endsWith('scope=settings') ? settingsResponse : modelsResponse
      if (typeof response === 'function') response = response()
      response = await response
      if (response instanceof Error) throw response
      if (typeof response?.json === 'function') return response
      return { ok: true, json: async () => structuredClone(response) }
    },
  })
  const ctx = { locale: { getLocale: () => locale }, effect: callback => callback(),
    slots: { inject: (_name, register) => register(), register: (options, value) => {
      registrations.push(options)
      if (options.name === 'plugins.bundle.config') component = value
    } } }
  plugin.apply(ctx)
  const render = () => {
    cursor = 0; effectCursor = 0
    const node = component({ view: 'detail' }), tree = node.type(node.props)
    while (pending.length) pending.shift()()
    return tree
  }
  const nodes = root => typeof root !== 'object' || !root ? [] : [root, ...root.props.children.flatMap(nodes)]
  const all = () => nodes(render())
  const byLabel = label => all().find(node => node.props['aria-label'] === label)
  const save = () => all().find(node => node.props.className === 'dsh-cache-settings-save')
  const button = label => all().find(node => node.type === 'button' && node.props['aria-label'] === label)
  const change = (label, value) => { const node = byLabel(label); assert.ok(node, label); node.props.onChange({ target: { value } }) }
  const click = label => { const node = button(label); assert.ok(node, label); assert.equal(Boolean(node.props.disabled), false, label); return node.props.onClick() }
  const textOf = node => typeof node === 'object' && node ? node.props.children.map(textOf).join(' ') : String(node ?? '')
  const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); return render() }
  const tick = async ms => {
    clock += ms
    for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback() }
    return flush()
  }
  const lifetime = (id, lang = locale) => byLabel(`${lang === 'zh' ? '预计缓存有效期（分钟）' : 'Estimated cache lifetime (minutes)'} ${id}`)
  const toggle = id => byLabel(`${locale === 'zh' ? '允许保温' : 'Allow warming'} ${id}`)
  const cards = () => all().filter(node => node.props['data-model'])
  render()
  return { render, all, byLabel, save, button, change, click, text: () => textOf(render()), flush, tick, timers, lifetime, toggle, cards, posts, requests, registrations, styles,
    setModels: value => { modelsResponse = value }, setSettings: value => { settingsResponse = value }, setPost: value => { postResponse = value },
    unmount: () => effects.forEach(effect => effect.cleanup?.()) }
}

for (const locale of ['en', 'zh']) test(`one numeric lifetime and independent allow toggle; canonical numeric/blank payload (${locale})`, async () => {
  const f = fixture({ locale, settings: { ...base, modelPolicies: [policy('openrouter', 'deepseek/flash', null)] } })
  await f.flush()
  const id = 'openrouter/deepseek/flash'
  assert.equal(f.lifetime(id).props.value, '')
  assert.match(f.lifetime(id).props.className, /dsh-cache-policy-minutes/)
  assert.equal(f.toggle(id).props.role, 'switch')
  assert.equal(f.all().filter(node => node.type === 'input' && node.props.type === 'number').length, 5)
  assert.equal(f.all().filter(node => node.props.role === 'switch').length, 2, 'new-chat and per-model native switches')
  assert.equal(f.all().filter(node => node.props.type === 'checkbox').length, 0, 'model uses native switch rather than checkbox')
  assert.ok(!f.all().some(node => node.type === 'input' && node.props.type === 'text'), 'no manual IDs')
  f.lifetime(id).props.onChange({ target: { value: '45' } })
  assert.equal(f.toggle(id).props['aria-checked'], false, 'editing lifetime does not enable warming')
  assert.equal(f.save().props.disabled, false)
  await f.save().props.onClick()
  assert.deepEqual(f.posts[0].modelPolicies, [policy('openrouter', 'deepseek/flash', 45)])
  f.lifetime(id).props.onChange({ target: { value: '0' } })
  assert.equal(f.save().props.disabled, true)
  f.lifetime(id).props.onChange({ target: { value: '1.5' } })
  assert.equal(f.save().props.disabled, true)
  f.lifetime(id).props.onChange({ target: { value: '' } })
  f.toggle(id).props.onClick()
  await f.save().props.onClick()
  assert.deepEqual(f.posts[1].modelPolicies, [policy('openrouter', 'deepseek/flash', null, true)])
  assert.match(f.text(), locale === 'zh' ? /空白 — 不会自动保温/ : /Blank — no automatic warming/)
})

test('independent settings/model loads, automatic defaults, plugin-only registration and no catalog serialized', async () => {
  const pendingModels = deferred()
  const f = fixture({ settings: { ...base, defaultModelPolicies: [policy('ignored', 'legacy', 30, true)] }, models: pendingModels.promise })
  await f.flush()
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.some(request => request.url.endsWith('scope=settings')))
  assert.ok(f.requests.some(request => request.url.endsWith('scope=models')))
  f.change('Warming window while running (minutes)', '42')
  assert.equal(f.save().props.disabled, false, 'settings are usable while models load')
  pendingModels.resolve(codex)
  await f.flush()
  assert.equal(f.lifetime('codex-business/gpt-5').props.value, 30)
  assert.equal(f.toggle('codex-business/gpt-5').props['aria-checked'], true)
  assert.match(f.text(), /Codex estimated default/)
  assert.ok(!f.text().includes('Use Codex'))
  assert.ok(!f.button('Add model'))
  assert.equal(f.byLabel('Warming window while running (minutes)').props.value, 42, 'discovery preserves draft')
  await f.save().props.onClick()
  assert.deepEqual(Object.keys(f.posts[0]).sort(), ['scope', ...Object.keys(base)].sort())
  assert.deepEqual(f.posts[0].modelPolicies, [])
  assert.equal(f.lifetime('codex-business/gpt-5').props.value, 30, 'base-only POST reply keeps catalog')
  assert.deepEqual(f.registrations.map(row => row.name), ['conversation.composer.dock', 'plugins.bundle.config'])
})

test('known defaults, custom lifetime, explicit blank, retained disabled lifetime and reset', async () => {
  const f = fixture({ models: codex })
  await f.flush()
  const id = 'codex-business/gpt-5'
  f.lifetime(id).props.onChange({ target: { value: '55' } })
  assert.equal(f.toggle(id).props['aria-checked'], true)
  assert.match(f.text(), /Custom/)
  f.toggle(id).props.onClick()
  assert.equal(f.lifetime(id).props.value, 55)
  assert.match(f.text(), /Disabled \(lifetime retained\)/)
  await f.save().props.onClick()
  assert.deepEqual(f.posts[0].modelPolicies, [policy('codex-business', 'gpt-5', 55)])
  f.lifetime(id).props.onChange({ target: { value: '' } })
  assert.equal(f.toggle(id).props['aria-checked'], false)
  await f.save().props.onClick()
  assert.deepEqual(f.posts[1].modelPolicies, [policy('codex-business', 'gpt-5', null)])
  f.click(`Reset to default ${id}`)
  assert.equal(f.lifetime(id).props.value, 30)
  assert.equal(f.toggle(id).props['aria-checked'], true)
  await f.save().props.onClick()
  assert.deepEqual(f.posts[2].modelPolicies, [])
})

test('legacy defaults=false remains hidden and reset writes an explicit metadata default', async () => {
  const f = fixture({ settings: { ...base, useCodexDefaults: false }, models: codex })
  await f.flush()
  const id = 'codex-business/gpt-5'
  assert.equal(f.lifetime(id).props.value, '')
  assert.equal(f.toggle(id).props['aria-checked'], false)
  assert.match(f.text(), /Defaults disabled by legacy settings/)
  f.click(`Reset to default ${id}`)
  assert.equal(f.lifetime(id).props.value, 30)
  assert.equal(f.toggle(id).props['aria-checked'], true)
  await f.save().props.onClick()
  assert.equal(f.posts[0].useCodexDefaults, false)
  assert.deepEqual(f.posts[0].modelPolicies, [policy('codex-business', 'gpt-5', 30, true)])
  assert.equal(f.all().filter(node => node.props.role === 'switch').length, 2)
})

test('large catalogs show full counts with bounded pages, provider groups and case-insensitive search', async () => {
  const f = fixture({ models: { providers: [provider('alpha', Array.from({ length: 130 }, (_, i) => model(`model-${i}`, { name: `Friendly ${i}` })), { name: 'Provider A' }),
    provider('beta', [model('special', { name: 'Special Model' }), model('other')], { name: 'Provider B' })] } })
  await f.flush()
  assert.equal(f.cards().length, 25)
  assert.match(f.text(), /Showing 25 of 132 matching models · 132 total/)
  assert.ok(f.all().some(node => node.type === 'option' && node.props.children.join('') === 'Provider A (130)'))
  f.click('Load more')
  assert.equal(f.cards().length, 50)
  f.change('Provider', 'beta')
  assert.equal(f.cards().length, 2)
  assert.match(f.text(), /Showing 2 of 2 matching models · 132 total/)
  assert.ok(!f.button('Load more'))
  f.change('Search models or providers', 'SPECIAL')
  assert.equal(f.cards().length, 1)
  assert.ok(f.lifetime('beta/special'))
  f.change('Search models or providers', 'nothing')
  assert.equal(f.cards().length, 0)
  assert.match(f.text(), /No matching models/)
  f.change('Provider', '')
  f.change('Search models or providers', 'provider a')
  assert.equal(f.cards().length, 25)
  f.change('Search models or providers', 'Friendly 129')
  assert.ok(f.lifetime('alpha/model-129'), 'models beyond 100 remain searchable/editable')
  f.lifetime('alpha/model-129').props.onChange({ target: { value: '15' } })
  await f.save().props.onClick()
  assert.deepEqual(f.posts[0].modelPolicies, [policy('alpha', 'model-129', 15)])
})

test('partial errors and unsupported reasons retain unavailable overrides; refresh preserves unsaved draft', async () => {
  const f = fixture({ settings: { ...base, modelPolicies: [policy('broken', 'saved-model', 45, true)] }, models: { providers: [
    provider('openrouter', [model('unsupported', { transportSupported: false, reasonCode: 'unsupported-protocol' })]),
    provider('broken', [], { name: 'Broken provider', error: 'model-discovery-timeout' }),
  ] } })
  await f.flush()
  assert.match(f.text(), /Model discovery timed out/)
  assert.match(f.text(), /Unavailable in catalog/)
  assert.match(f.text(), /Observation only · Unsupported protocol/)
  assert.equal(f.lifetime('openrouter/unsupported').props.disabled, false)
  f.lifetime('openrouter/unsupported').props.onChange({ target: { value: '12' } })
  f.lifetime('broken/saved-model').props.onChange({ target: { value: '50' } })
  f.change('Warming window while idle (minutes)', '27')
  f.setModels({ providers: [provider('broken', [model('saved-model')]), ...openrouter.providers] })
  f.click('Retry Broken provider')
  f.render()
  await f.flush()
  assert.equal(f.lifetime('broken/saved-model').props.value, 50)
  assert.equal(f.byLabel('Warming window while idle (minutes)').props.value, 27)
  assert.ok(f.lifetime('openrouter/unsupported'), 'new unsaved override retained after model disappears')
  await f.save().props.onClick()
  assert.deepEqual(f.posts[0].modelPolicies, [policy('broken', 'saved-model', 50, true), policy('openrouter', 'unsupported', 12)])
  f.click('Remove override openrouter/unsupported')
  await f.save().props.onClick()
  assert.deepEqual(f.posts[1].modelPolicies, [policy('broken', 'saved-model', 50, true)])
})

test('provider discovery failures never discard saved overrides and retries can recover', async () => {
  const f = fixture({ settings: { ...base, modelPolicies: [policy('missing', 'ghost', 20)] }, models: new Error('offline') })
  await f.flush()
  assert.match(f.text(), /Provider discovery failed/)
  assert.equal(f.lifetime('missing/ghost').props.value, 20)
  f.lifetime('missing/ghost').props.onChange({ target: { value: '22' } })
  f.setModels({ providers: [], error: 'provider-discovery-failed' })
  f.click('Refresh models'); f.render(); await f.flush()
  assert.equal(f.lifetime('missing/ghost').props.value, 22)
  assert.match(f.text(), /Provider discovery failed/)
  f.setModels({ providers: [provider('missing', [model('ghost')])] })
  f.click('Retry'); f.render(); await f.flush()
  assert.equal(f.lifetime('missing/ghost').props.value, 22)
  assert.ok(!f.text().includes('Provider discovery failed'))
  await f.save().props.onClick()
  assert.deepEqual(f.posts[0].modelPolicies, [policy('missing', 'ghost', 22)])
})

test('settings failures retry independently from discovery and save failure keeps edits', async () => {
  const f = fixture({ settings: new Error('offline'), models: codex })
  await f.flush()
  assert.match(f.text(), /Could not load settings/)
  assert.ok(f.lifetime('codex-business/gpt-5'))
  assert.equal(f.lifetime('codex-business/gpt-5').props.disabled, true)
  f.setSettings(base)
  f.click('Retry'); f.render(); await f.flush()
  f.lifetime('codex-business/gpt-5').props.onChange({ target: { value: '60' } })
  f.setPost(new Error('offline'))
  await f.save().props.onClick()
  assert.match(f.text(), /Save failed; unsaved changes are preserved/)
  assert.equal(f.lifetime('codex-business/gpt-5').props.value, 60)
  assert.equal(f.save().props.disabled, false)
})

test('100-override validation does not limit discovery and existing overrides remain editable/removable', async () => {
  const modelPolicies = Array.from({ length: 100 }, (_, i) => policy('saved', `model-${i}`, 20))
  const f = fixture({ settings: { ...base, modelPolicies }, models: codex })
  await f.flush()
  assert.match(f.text(), /101 total · 100\/100 overrides/)
  assert.equal(f.lifetime('codex-business/gpt-5').props.disabled, true)
  assert.equal(f.toggle('codex-business/gpt-5').props.disabled, true)
  f.change('Search models or providers', 'saved/model') // search is not a manual ID field
  f.change('Search models or providers', 'model-0')
  assert.equal(f.lifetime('saved/model-0').props.disabled, false)
  f.click('Remove override saved/model-0')
  f.change('Search models or providers', 'GPT')
  assert.equal(f.lifetime('codex-business/gpt-5').props.disabled, false)
  f.lifetime('codex-business/gpt-5').props.onChange({ target: { value: '44' } })
  await f.save().props.onClick()
  assert.equal(f.posts[0].modelPolicies.length, 100)
  assert.deepEqual(f.posts[0].modelPolicies.at(-1), policy('codex-business', 'gpt-5', 44, true))
})

for (const locale of ['en', 'zh']) test(`settings explain default opt-in and request-anchored windows (${locale})`, async () => {
  const f = fixture({ locale })
  await f.flush()
  const helpers = f.all().filter(n => n.props.className === 'dsh-cache-settings-help')
  assert.equal(helpers.length, 5)
  const described = f.all().filter(n => n.props['aria-describedby'])
  assert.equal(described.length, 5)
  for (const control of described) assert.ok(helpers.some(n => n.props.id === control.props['aria-describedby']))
  assert.match(f.text(), /14:00/)
  assert.match(f.text(), /14:30/)
  assert.match(f.text(), locale === 'zh' ? /并非从运行结束时重新计时/ : /not after the run ends/)
  assert.match(f.text(), locale === 'zh' ? /不是刷新间隔/ : /not refresh intervals/)
  assert.match(f.text(), locale === 'zh' ? /不会改变已有对话或子智能体对话/ : /Existing chats and subagent chats are unchanged/)
})

for (const locale of ['en', 'zh']) test(`collapsed plugin cost checks explain assumptions and save canonical values (${locale})`, async () => {
  const modelPolicies = [policy('saved', 'current-rule', 45, true)]
  const f = fixture({ locale, settings: { ...base, modelPolicies }, models: codex })
  await f.flush()
  const benefit = locale === 'zh' ? '最低预计净收益（美元）' : 'Minimum expected net benefit (USD)'
  const probability = locale === 'zh' ? '空闲时继续对话的概率（%）' : 'Idle continuation probability (%)'
  const details = f.all().filter(node => node.type === 'details')
  assert.equal(details.length, 1)
  assert.ok(!details[0].props.open, 'native details starts collapsed')
  assert.equal(details[0].props.children[0].type, 'summary')
  assert.deepEqual(details[0].props.children[0].props.children, [locale === 'zh' ? '高级 / 费用检查' : 'Advanced / Cost checks'])
  assert.equal(f.byLabel(benefit).props.value, 0.05)
  assert.equal(f.byLabel(benefit).props.step, 0.001)
  assert.equal(f.byLabel(benefit).props.min, 0)
  assert.equal(f.byLabel(benefit).props.max, 1000)
  assert.equal(f.byLabel(probability).props.value, 15)
  assert.equal(f.byLabel(probability).props.step, 1)
  assert.equal(f.byLabel(probability).props.min, 0)
  assert.equal(f.byLabel(probability).props.max, 100)
  assert.match(f.text(), locale === 'zh' ? /降低门槛可能增加保温请求和用量/ : /lower threshold can mean more warming and usage/)
  assert.match(f.text(), locale === 'zh' ? /提高概率可能增加保温和用量/ : /higher probability can mean more warming and usage/)
  assert.match(f.text(), locale === 'zh' ? /设为 0 会阻止空闲保温/ : /0 blocks idle warming/)
  assert.match(f.text(), locale === 'zh' ? /固定为 100%/ : /fixed at 100%/)
  assert.match(f.text(), locale === 'zh' ? /本地决策假设/ : /local decision assumptions/)
  assert.match(f.text(), locale === 'zh' ? /API 等价估计，并非账单或订阅配额/ : /API-equivalent estimates, not a bill or subscription quota/)
  f.change(benefit, '0.003')
  f.change(probability, '60')
  await f.save().props.onClick()
  assert.equal(f.posts[0].minExpectedBenefitUsd, 0.003)
  assert.equal(f.posts[0].idleContinuationPercent, 60)
  assert.deepEqual(f.posts[0].modelPolicies, modelPolicies, 'cost-only save preserves all current rules')
  assert.equal(f.lifetime('codex-business/gpt-5').props.value, 30, 'cost-only save preserves discovered defaults')
  assert.equal(f.lifetime('saved/current-rule').props.value, 45)
  assert.deepEqual(f.registrations.map(row => row.name), ['conversation.composer.dock', 'plugins.bundle.config'])
})

test('older host supplies advanced defaults on both GET and POST without changing policies/catalog', async () => {
  const { minExpectedBenefitUsd: _benefit, idleContinuationPercent: _probability, ...legacy } = base
  legacy.modelPolicies = [policy('saved', 'rule', 35)]
  const f = fixture({ settings: legacy, models: codex })
  await f.flush()
  assert.equal(f.byLabel('Minimum expected net benefit (USD)').props.value, 0.05)
  assert.equal(f.byLabel('Idle continuation probability (%)').props.value, 15)
  f.change('Warming window while running (minutes)', '40')
  f.setPost({ ...legacy, activeMinutes: 40 })
  await f.save().props.onClick()
  assert.equal(f.posts[0].minExpectedBenefitUsd, 0.05)
  assert.equal(f.posts[0].idleContinuationPercent, 15)
  assert.deepEqual(f.posts[0].modelPolicies, legacy.modelPolicies)
  assert.equal(f.byLabel('Minimum expected net benefit (USD)').props.value, 0.05)
  assert.equal(f.byLabel('Idle continuation probability (%)').props.value, 15)
  assert.equal(f.lifetime('saved/rule').props.value, 35)
  assert.equal(f.lifetime('codex-business/gpt-5').props.value, 30)
  assert.equal(f.save().props.disabled, true)
})

for (const [label, invalid, valid] of [
  ['Minimum expected net benefit (USD)', ['', ' ', '-0.001', '1000.001', 'Infinity', 'NaN', 'not a number'], ['0', '0.001', '1000']],
  ['Idle continuation probability (%)', ['', ' ', '-1', '100.1', '101', '0.5', 'Infinity', 'NaN'], ['0', '1', '100']],
  ['Warming window while running (minutes)', ['', '-1', '1.5', '1441', 'Infinity'], ['0', '1', '1440']],
  ['Warming window while idle (minutes)', ['', '-1', '1.5', '1441', 'Infinity'], ['0', '1', '1440']],
]) test(`${label} blocks invalid input and accepts numeric boundaries`, async () => {
  const f = fixture()
  await f.flush()
  for (const value of invalid) {
    f.change(label, value)
    assert.equal(f.save().props.disabled, true, value)
    await f.save().props.onClick() // handler also rejects even if invoked directly
    assert.equal(f.posts.length, 0, value)
    assert.match(f.text(), /Required fields cannot be blank/)
    if (!value.trim()) assert.equal(f.byLabel(label).props.value, '', 'blank remains blank, not zero')
  }
  for (const value of valid) {
    f.change(label, value)
    assert.equal(f.save().props.disabled, false, value)
    await f.save().props.onClick()
    assert.equal(f.save().props.disabled, true)
  }
  assert.equal(f.posts.length, valid.length)
})

for (const [field, value] of [
  ['minExpectedBenefitUsd', null], ['minExpectedBenefitUsd', '0.05'], ['minExpectedBenefitUsd', Infinity],
  ['idleContinuationPercent', null], ['idleContinuationPercent', '15'], ['idleContinuationPercent', 15.5],
]) test(`malformed host ${field}=${String(value)} is not silently defaulted`, async () => {
  const f = fixture({ settings: { ...base, [field]: value } })
  await f.flush()
  f.change('Warming window while running (minutes)', '40')
  assert.equal(f.save().props.disabled, true)
  await f.save().props.onClick()
  assert.deepEqual(f.posts, [])
})

test('advanced controls preserve native typography, compact lifetime width and mobile input sizing', async () => {
  const f = fixture()
  await f.flush()
  const css = f.styles.join('\n')
  assert.match(css, /\.dsh-cache-settings-label\{[^}]*font-size:13px/)
  assert.match(css, /\.dsh-cache-settings-advanced summary\{[^}]*font-size:14px/)
  assert.match(css, /\.dsh-cache-policy-minutes\{width:96px/)
  assert.match(css, /@media\(max-width:480px\).*dsh-cache-settings-input\{font-size:16px\}/)
  assert.equal(f.all().filter(node => node.props.role === 'switch').length, 2)
})

for (const locale of ['en', 'zh']) test(`stalled reads time out, abort, expose Retry and reject late stale results (${locale})`, async () => {
  const waitingSettings = deferred(), waitingModels = deferred()
  const f = fixture({ locale, settings: waitingSettings.promise, models: waitingModels.promise })
  await f.flush()
  await f.tick(24999)
  assert.ok(!f.button(locale === 'zh' ? '重试' : 'Retry'))
  await f.tick(1)
  // Both reads share one window: the host serves them one at a time, so a slow
  // discovery must not fail the settings panel next to it.
  assert.match(f.text(), locale === 'zh' ? /设置加载超时/ : /Settings took too long/)
  assert.match(f.text(), locale === 'zh' ? /模型加载超时/ : /Models took too long/)
  assert.equal(f.timers.size, 0)
  assert.ok(f.requests.every(request => request.options.signal.aborted))
  f.setSettings(base); f.setModels(codex)
  await f.click(locale === 'zh' ? '重试' : 'Retry')
  f.render(); await f.flush()
  await f.click(locale === 'zh' ? '刷新模型' : 'Refresh models')
  f.render(); await f.flush()
  assert.equal(f.lifetime('codex-business/gpt-5').props.value, 30)
  assert.equal(f.byLabel(locale === 'zh' ? '运行中保温窗口（分钟）' : 'Warming window while running (minutes)').props.value, 60)
  waitingSettings.resolve({ ...base, activeMinutes: 1 }); waitingModels.resolve(openrouter)
  await f.flush()
  assert.equal(f.lifetime('codex-business/gpt-5').props.value, 30, 'late catalog cannot replace retry')
  assert.equal(f.byLabel(locale === 'zh' ? '运行中保温窗口（分钟）' : 'Warming window while running (minutes)').props.value, 60)
  assert.equal(f.timers.size, 0)
  f.unmount()
})

test('JSON body stalls are bounded too; failed refresh preserves catalog and unsaved settings', async () => {
  const f = fixture({ models: codex })
  await f.flush()
  assert.equal(f.timers.size, 0, 'successful reads clear deadlines')
  f.change('Warming window while running (minutes)', '42')
  const body = deferred()
  f.setModels({ ok: true, json: () => body.promise })
  await f.click('Refresh models'); f.render(); await f.flush(); await f.tick(25000)
  assert.match(f.text(), /Models took too long/)
  assert.equal(f.lifetime('codex-business/gpt-5').props.value, 30)
  assert.equal(f.byLabel('Warming window while running (minutes)').props.value, 42)
  assert.equal(f.button('Refresh models').props.disabled, false)
  body.resolve(openrouter); await f.flush()
  assert.equal(f.lifetime('codex-business/gpt-5').props.value, 30)
  assert.equal(f.timers.size, 0)
  f.unmount()
})

test('unmount cancels deadlines even when read promises never settle', async () => {
  const f = fixture({ settings: new Promise(() => {}), models: new Promise(() => {}) })
  await f.flush(); assert.equal(f.timers.size, 2)
  f.unmount(); await f.flush()
  assert.equal(f.timers.size, 0)
  assert.ok(f.requests.every(request => request.options.signal.aborted))
  assert.equal(f.save(), undefined)
})

test('both read requests are aborted when the settings component unmounts', async () => {
  const waiting = deferred()
  const f = fixture({ settings: waiting.promise, models: waiting.promise })
  await f.flush()
  assert.equal(f.requests.length, 2)
  f.unmount()
  assert.ok(f.requests.every(request => request.options.signal.aborted))
  waiting.resolve(base)
  await f.flush()
  assert.equal(f.save(), undefined)
})
