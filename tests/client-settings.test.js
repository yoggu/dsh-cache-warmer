import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Exercise the actual plain-JS settings component without importing private UI
// packages or issuing browser/network requests. Host validation is tested separately.
function fixture(locale = 'en') {
  const row = { provider: 'openrouter', model: '~deepseek/deepseek-v4-flash-latest', enabled: false, cacheMinutes: null }
  const settings = { autoWarmNewChats: false, activeMinutes: 60, idleMinutes: 30, useCodexDefaults: true, modelPolicies: [row] }
  const state = [settings, structuredClone(settings), [], false, '', locale]
  let cursor = 0, plugin, component
  const posts = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity).filter(x => x !== null && x !== false) } }),
    useState: initial => { const index = cursor++; if (state[index] === undefined) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }] },
    useId: () => 'test-policy', useEffect: () => {}, Fragment: 'fragment',
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => { plugin = module.factory(name => name === 'react' ? React : {}) } } },
    fetch: async (_url, options) => { const body = JSON.parse(options.body); posts.push(body); return { ok: true, json: async () => body } },
  })
  const ctx = { locale: { getLocale: () => locale }, effect: () => {},
    slots: { inject: (_name, register) => register(), register: (options, value) => { if (options.name === 'plugins.bundle.config') component = value } } }
  plugin.apply(ctx)
  const render = () => { cursor = 0; const node = component({ view: 'detail' }); return node.type(node.props) }
  const nodes = root => typeof root !== 'object' || !root ? [] : [root, ...root.props.children.flatMap(nodes)]
  return { render, nodes, posts, state }
}

for (const locale of ['en', 'zh']) test(`settings render one lifetime field and save its numeric/blank value (${locale})`, async () => {
  const f = fixture(locale)
  const title = locale === 'en' ? 'Estimated cache lifetime (minutes) 1' : '预计缓存有效期（分钟） 1'
  const controls = () => f.nodes(f.render())
  const input = () => controls().find(node => node.type === 'input' && node.props['aria-label'] === title)
  const save = () => controls().find(node => node.props.className === 'dsh-cache-settings-save')
  assert.equal(input().props.value, '')
  assert.equal(controls().filter(node => node.type === 'input' && node.props.type === 'number').length, 3, 'two base windows plus one lifetime')
  assert.ok(!controls().some(node => /^(short|long) \(minutes\)/.test(node.props['aria-label'] || '')))
  input().props.onChange({ target: { value: '45' } })
  assert.equal(save().props.disabled, false)
  await save().props.onClick()
  assert.deepEqual(f.posts[0].modelPolicies[0], { provider: 'openrouter', model: '~deepseek/deepseek-v4-flash-latest', enabled: false, cacheMinutes: 45 })
  assert.equal(f.posts[0].defaultModelPolicies, undefined)
  input().props.onChange({ target: { value: '0' } })
  assert.equal(save().props.disabled, true)
  input().props.onChange({ target: { value: '' } })
  await save().props.onClick()
  assert.equal(f.posts[1].modelPolicies[0].cacheMinutes, null)
})
