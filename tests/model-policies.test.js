import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MINUTE, OPENROUTER_MODEL,
  decisionDelay, nextDecisionAt, normalizeModelPolicies,
  policyFor, warmingDecision,
} from '../lib/policy.js'

const route = { provider: 'openrouter', model: 'openai/gpt-4.1' }
const codex = route // Legacy test fixture name; all positive transport tests use OpenRouter.
const row = (overrides = {}) => ({ ...route, enabled: true, cacheMinutes: 30, ...overrides })
const legacyRow = (overrides = {}) => ({ ...route, enabled: true, shortMinutes: 5, longMinutes: 30, ...overrides })
const settings = (rule, extra = {}) => ({ modelPolicies: [rule], ...extra })
const at = (s, tier = 'long', selected = route) => policyFor(selected.provider, selected.model, s, tier)

// Configuration is intentionally narrow: an estimate is not a provider capability.
test('model policies canonicalize one cache estimate without mutating input', () => {
  assert.deepEqual(normalizeModelPolicies(undefined), [])
  assert.deepEqual(normalizeModelPolicies([]), [])
  const source = Object.freeze({ ...codex, enabled: false })
  const canonical = normalizeModelPolicies(Object.freeze([source]))
  assert.deepEqual(canonical, [row({ enabled: false, cacheMinutes: null })])
  assert.notEqual(canonical[0], source)
  for (const cacheMinutes of [null, undefined, 1, 10080]) {
    const input = Object.freeze(row({ cacheMinutes }))
    const result = normalizeModelPolicies(Object.freeze([input]))
    assert.deepEqual(result, [row({ cacheMinutes: cacheMinutes ?? null })])
    assert.notEqual(result[0], input)
    assert.deepEqual(normalizeModelPolicies(result), result, 'canonical output is idempotent')
  }
})

test('legacy tiers migrate to the shortest known estimate, never lengthening either mode', () => {
  for (const [shortMinutes, longMinutes] of [[5, 30], [83, 7], [30, 30], [1, 10080], [10080, 1]]) {
    const source = Object.freeze(legacyRow({ shortMinutes, longMinutes }))
    const expected = Math.min(shortMinutes, longMinutes)
    const migrated = normalizeModelPolicies(Object.freeze([source]))
    assert.deepEqual(migrated, [row({ cacheMinutes: expected })])
    assert.notEqual(migrated[0], source)
    assert.deepEqual(normalizeModelPolicies(migrated), migrated)
    for (const retention of ['short', 'long']) {
      const p = at(settings(source), retention)
      assert.equal(p.ruleSource, 'custom')
      assert.equal(p.cacheTtlMs, expected * MINUTE)
      assert.equal(decisionDelay(p), decisionDelay(at(settings(migrated[0]), retention)))
    }
  }
})

test('legacy migration keeps both modes unknown if either tier is missing or null', () => {
  const source = { ...codex, enabled: true }
  const unknownRows = [
    source, { ...source, shortMinutes: 5 }, { ...source, longMinutes: 30 },
    legacyRow({ shortMinutes: null }), legacyRow({ longMinutes: null }),
    legacyRow({ shortMinutes: undefined }), legacyRow({ longMinutes: undefined }),
    legacyRow({ shortMinutes: null, longMinutes: null }),
  ]
  for (const input of unknownRows) {
    assert.deepEqual(normalizeModelPolicies([input]), [row({ cacheMinutes: null })])
    for (const retention of ['short', 'long']) {
      const p = at(settings(input), retention)
      assert.equal(p.ruleSource, 'custom', 'unknown overrides never restore Codex defaults')
      assert.equal(p.cacheTtlMs, null)
      assert.equal(decisionDelay(p), null)
    }
  }
})

test('mixed new and legacy fields are rejected even when null or undefined', () => {
  for (const cacheMinutes of [30, null, undefined]) {
    for (const legacyMinutes of [5, null, undefined]) {
      for (const legacy of [
        { shortMinutes: legacyMinutes }, { longMinutes: legacyMinutes },
        { shortMinutes: legacyMinutes, longMinutes: legacyMinutes },
      ]) {
        assert.throws(() => normalizeModelPolicies([row({ cacheMinutes, ...legacy })]), /cannot be mixed/)
      }
    }
  }
})

test('model policy rows enforce exact ids and required boolean enablement', () => {
  const invalidRows = [
    null, [], 2, 'row', new Date(), Object.create({ provider: codex.provider, model: codex.model, enabled: true }),
    row({ provider: '' }), row({ provider: ' openrouter' }), row({ provider: 'openrouter ' }), row({ provider: 'openrouter\n' }),
    row({ provider: 'open/router' }), row({ provider: '*' }), row({ provider: 'p'.repeat(129) }),
    row({ model: '' }), row({ model: ' gpt-6-astra' }), row({ model: 'gpt-6-astra\n' }),
    row({ model: 'gpt-*' }), row({ model: 'gpt-?' }), row({ model: 'gpt-[56]' }),
    row({ model: '{gpt-5,gpt-6}' }), row({ model: 'm'.repeat(257) }),
    row({ enabled: undefined }), row({ enabled: null }), row({ enabled: 1 }), row({ enabled: 'true' }),
    row({ extra: 30 }), { ...row(), [Symbol('extra')]: true },
  ]
  for (const invalid of invalidRows) assert.throws(() => normalizeModelPolicies([invalid]), TypeError)
  for (const key of ['provider', 'model', 'enabled']) {
    const missing = row()
    delete missing[key]
    assert.throws(() => normalizeModelPolicies([missing]), /required/)
  }
  assert.deepEqual(normalizeModelPolicies([Object.assign(Object.create(null), row())]), [row()])
  assert.deepEqual(normalizeModelPolicies([row({ provider: 'a_B.1-2', model: '~vendor/model-v1:variant' })]),
    [row({ provider: 'a_B.1-2', model: '~vendor/model-v1:variant' })])
  assert.doesNotThrow(() => normalizeModelPolicies([row({ provider: 'p'.repeat(128), model: 'm'.repeat(256) })]))
})

test('new and legacy minutes reject non-integers, out-of-range values and coercion', () => {
  for (const value of [0, -1, 1.5, 10081, NaN, Infinity, '5', false, {}, []]) {
    assert.throws(() => normalizeModelPolicies([row({ cacheMinutes: value })]), /cacheMinutes/)
    for (const key of ['shortMinutes', 'longMinutes']) {
      const other = key === 'shortMinutes' ? 'longMinutes' : 'shortMinutes'
      for (const otherValue of [30, null, undefined]) {
        assert.throws(() => normalizeModelPolicies([legacyRow({ [key]: value, [other]: otherValue })]), new RegExp(key))
      }
    }
  }
})

test('array validation rejects duplicate pairs, sparse rows and too many rules', () => {
  for (const invalid of [null, false, {}, '[]', new Array(1)]) {
    assert.throws(() => normalizeModelPolicies(invalid), TypeError)
  }
  assert.throws(() => normalizeModelPolicies([row(), row({ enabled: false })]), /duplicate/)
  assert.throws(() => normalizeModelPolicies([row(), legacyRow()]), /duplicate/)
  assert.throws(() => normalizeModelPolicies([legacyRow(), legacyRow({ shortMinutes: null })]), /duplicate/)
  assert.deepEqual(normalizeModelPolicies([row(), legacyRow({ model: 'gpt-6-sol' })]),
    [row(), row({ model: 'gpt-6-sol', cacheMinutes: 5 })])
  const unique = Array.from({ length: 100 }, (_, i) => row({ model: `model-${i}` }))
  assert.equal(normalizeModelPolicies(unique).length, 100)
  assert.throws(() => normalizeModelPolicies([...unique, row({ model: 'model-100' })]), /100/)
  assert.equal(normalizeModelPolicies([row(), row({ provider: 'codex-personal' }), row({ model: 'GPT-6-ASTRA' })]).length, 3)
})

test('exact custom rules share one estimate across both modes with no alias or case matching', () => {
  const s = settings(row({ cacheMinutes: 7 }))
  for (const retention of ['short', 'long']) {
    assert.equal(at(s, retention).cacheTtlMs, 7 * MINUTE)
    assert.equal(decisionDelay(at(s, retention)), 6.3 * MINUTE)
    const state = { lastRequestAt: 1000, lastCacheHitAt: 1000, agentRunning: false }
    assert.equal(nextDecisionAt(state, true, { activeMinutes: 60, idleMinutes: 30 }, at(s, retention), 1000),
      1000 + 6.3 * MINUTE)
  }
  assert.equal(at(s).retention, 'long')
  assert.equal(at(s).ruleSource, 'custom')
  assert.equal(at(s).warmingAllowed, true)
  assert.equal(at(s).transportSupported, true)
  assert.match(at(s).cacheEstimateSource, /User-configured.*not provider-reported/)
  assert.equal(at(s, 'long', { ...route, provider: 'openai-codex' }), null)
  assert.equal(at(s, 'long', { ...route, model: 'OPENAI/GPT-4.1' }).ruleSource, 'unknown')
  assert.equal(at(s, 'long', { ...route, model: OPENROUTER_MODEL }).cacheTtlMs, null)
})

test('blank and disabled overrides suppress fallback while retaining useful observations', () => {
  for (const retention of ['short', 'long']) {
    for (const input of [{ ...codex, enabled: true }, row({ cacheMinutes: null })]) {
      const blank = at(settings(input), retention)
      assert.equal(blank.ruleSource, 'custom')
      assert.equal(blank.cacheTtlMs, null)
      assert.equal(blank.warmingAllowed, true)
      assert.equal(decisionDelay(blank), null)
    }
    const disabled = at(settings(row({ enabled: false, cacheMinutes: 42 })), retention)
    assert.equal(disabled.ruleSource, 'custom')
    assert.equal(disabled.warmingAllowed, false)
    assert.equal(disabled.cacheTtlMs, 42 * MINUTE, 'configured estimate may display even when warming is disabled')
    assert.equal(decisionDelay(disabled), null)
  }
})

test('legacy and OAuth Codex routes cannot schedule even with saved opt-ins', () => {
  for (const provider of ['codex-personal', 'codex-business', 'openai-codex', 'deepseek-official']) {
    const oldPolicy = policyFor(provider, 'gpt-6-sol', settings(row({ provider, model: 'gpt-6-sol' })))
    assert.equal(oldPolicy.transportSupported, false)
    assert.equal(oldPolicy.warmingAllowed, false)
    assert.equal(decisionDelay(oldPolicy), null)
    assert.equal(nextDecisionAt({ lastRequestAt: 1000, agentRunning: true }, true,
      { activeMinutes: 60, idleMinutes: 30 }, oldPolicy, 1000), null)
  }
  const baseline = at({})
  assert.equal(baseline.ruleSource, 'unknown')
  assert.equal(baseline.subscription, false)
  assert.equal(baseline.kind, 'openrouter')
  assert.equal(baseline.outputReserve, 8)
  assert.equal(baseline.cacheTtlMs, null)
  assert.equal(at(settings(row())).cacheTtlMs, 30 * MINUTE)
  for (const retention of [null, '', 'none', 'unknown', 'LONG', 30]) {
    assert.equal(at(settings(row()), retention).cacheTtlMs, null)
    assert.equal(decisionDelay(at(settings(row()), retention)), null)
  }
})

test('OpenRouter never invents a lifetime or cadence; compatible catalog models can warm', () => {
  for (const model of [OPENROUTER_MODEL, 'anthropic/claude-sonnet-4', 'new/model']) {
    const p = policyFor('openrouter', model)
    assert.equal(p.kind, 'openrouter')
    assert.equal(p.subscription, false)
    assert.equal(p.cacheTtlMs, null)
    assert.equal(p.ruleSource, 'unknown')
    assert.equal(p.warmingAllowed, false)
    assert.equal(Object.hasOwn(p, 'decisionIntervalMs'), false)
    assert.equal(decisionDelay(p), null)
  }
  for (const retention of ['short', 'long']) {
    const reviewed = policyFor('openrouter', OPENROUTER_MODEL,
      settings(row({ provider: 'openrouter', model: OPENROUTER_MODEL, cacheMinutes: 5 })), retention)
    assert.equal(reviewed.transportSupported, true)
    assert.equal(reviewed.maxOutputTokens, 8)
    assert.equal(reviewed.cacheTtlMs, 5 * MINUTE)
    assert.equal(decisionDelay(reviewed), 4.5 * MINUTE)
  }
  for (const model of ['openai/gpt-4.1', 'openai/gpt-5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat']) {
    const p = policyFor('openrouter', model, settings(row({ provider: 'openrouter', model, cacheMinutes: 10 })))
    assert.equal(p.transportSupported, true, model)
    assert.equal(p.cacheTtlMs, 10 * MINUTE)
    assert.equal(decisionDelay(p), 9 * MINUTE)
  }
  const unsupported = policyFor('openrouter', 'unknown/model',
    settings(row({ provider: 'openrouter', model: 'unknown/model' })))
  assert.equal(unsupported.cacheTtlMs, 30 * MINUTE)
  assert.equal(unsupported.warmingAllowed, false)
  assert.equal(unsupported.transportSupported, false)
  assert.equal(decisionDelay(unsupported), null)
})

test('configured non-reviewed providers remain unsupported regardless of economic benefit', () => {
  assert.equal(policyFor('custom-provider', 'custom-model'), null)
  const p = policyFor('custom-provider', 'custom-model',
    settings(row({ provider: 'custom-provider', model: 'custom-model' })))
  assert.equal(p.kind, 'unsupported')
  assert.equal(p.ruleSource, 'custom')
  assert.equal(p.cacheTtlMs, 30 * MINUTE)
  assert.equal(p.warmingAllowed, false)
  assert.equal(p.transportSupported, false)
  assert.equal(decisionDelay(p), null)
})

test('scheduler requires both policy gates and a known TTL; legacy cadence is ignored', () => {
  const p = at(settings(row()))
  const state = { lastRequestAt: 1000, lastCacheHitAt: 1000, agentRunning: false }
  const s = { activeMinutes: 60, idleMinutes: 30 }
  assert.equal(nextDecisionAt(state, true, s, p, 1000), 1000 + 27 * MINUTE)
  for (const blocked of [null, { ...p, warmingAllowed: false }, { ...p, transportSupported: false },
    { ...p, cacheTtlMs: null, decisionIntervalMs: 5 * MINUTE }]) {
    assert.equal(decisionDelay(blocked), null)
    assert.equal(nextDecisionAt(state, true, s, blocked, 1000), null)
  }
  assert.equal(nextDecisionAt(state, false, s, p, 1000), null)
})

test('pure economics remain independent of scheduling gates with supplied prices', () => {
  const usage = { inputTokens: 1000, cacheReadTokens: 200000, outputTokens: 2 }
  const cost = { input: 10, cacheRead: 1, cacheWrite: 12, output: 50 }
  const p = at(settings(row()))
  const estimate = buckets => Object.entries(buckets).reduce((sum, [key, amount]) => sum + amount * cost[key] / 1e6, 0)
  const enabled = warmingDecision({ usage, estimate, policy: p, active: true })
  const disabled = warmingDecision({ usage, estimate, policy: { ...p, warmingAllowed: false, cacheTtlMs: null }, active: true })
  assert.deepEqual(enabled, disabled)
  assert.equal(enabled.outputReserve, 8)
})

test('there are no implicit account-route lifetimes; legacy settings remain observational', () => {
  for (const provider of ['openai-codex', 'codex-personal', 'codex-business']) {
    const selected = { provider, model: 'gpt-6-sol' }
    assert.equal(policyFor(provider, selected.model), null)
    const configured = policyFor(provider, selected.model, settings(row(selected)))
    assert.equal(configured.cacheTtlMs, 30 * MINUTE)
    assert.equal(configured.warmingAllowed, false)
  }
})

test('model enable toggle preserves the lifetime without overriding unknown TTL guard', () => {
  const disabled = row({ enabled: false, cacheMinutes: 30 })
  assert.deepEqual(normalizeModelPolicies([disabled]), [disabled])
  assert.equal(at(settings(disabled)).warmingAllowed, false)
  assert.equal(at(settings(disabled)).cacheTtlMs, 30 * MINUTE)
  assert.equal(at(settings(row({ cacheMinutes: null }))).warmingAllowed, true)
  assert.equal(decisionDelay(at(settings(row({ cacheMinutes: null })))), null)
})
