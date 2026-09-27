import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCostChecks, warmingDecision, policyFor, MINUTE } from '../lib/policy.js'
import { Config, statusFor } from '../lib/index.js'

const policy = policyFor('codex-personal', 'gpt-6-astra')
const usage = { inputTokens: 0, cacheReadTokens: 1000000, outputTokens: 1 }
const cost = { input: 10, cacheRead: 1, cacheWrite: 0, output: 0 }
const decision = (settings = {}, active = false, override = {}) => warmingDecision({ usage, cost, policy, active, settings, ...override })

test('cost settings are explicit finite numbers with strict defaults and ranges', () => {
  assert.deepEqual(normalizeCostChecks(), { minExpectedBenefitUsd: .05, idleContinuationPercent: 15 })
  for (const minExpectedBenefitUsd of [0, .001, .05, 1000])
    for (const idleContinuationPercent of [0, 15, 100])
      assert.deepEqual(normalizeCostChecks({ minExpectedBenefitUsd, idleContinuationPercent }), { minExpectedBenefitUsd, idleContinuationPercent })
  for (const minExpectedBenefitUsd of [null, '', '0.05', NaN, Infinity, -1, 1000.01, true])
    assert.throws(() => normalizeCostChecks({ minExpectedBenefitUsd }), TypeError)
  for (const idleContinuationPercent of [null, '', '15', NaN, Infinity, -1, 101, 15.1, true])
    assert.throws(() => normalizeCostChecks({ idleContinuationPercent }), TypeError)
})

test('plugin schema supplies default cost checks and rejects out-of-range values', () => {
  const defaults = Config({})
  assert.equal(defaults.minExpectedBenefitUsd, .05)
  assert.equal(defaults.idleContinuationPercent, 15)
  assert.equal(Config({ minExpectedBenefitUsd: 0 }).minExpectedBenefitUsd, 0)
  assert.equal(Config({ idleContinuationPercent: 100 }).idleContinuationPercent, 100)
  for (const patch of [{ minExpectedBenefitUsd: -1 }, { minExpectedBenefitUsd: 1001 },
    { idleContinuationPercent: -1 }, { idleContinuationPercent: 101 }, { idleContinuationPercent: 15.5 }])
    assert.throws(() => Config(patch))
})

test('configured threshold and idle probability change economics, not costs or active probability', () => {
  const baseline = decision()
  assert.equal(baseline.probability, .15)
  assert.equal(baseline.thresholdUsd, .05)
  assert.equal(baseline.worthwhile, true)
  const highThreshold = decision({ minExpectedBenefitUsd: 1 })
  assert.equal(highThreshold.worthwhile, false)
  assert.equal(highThreshold.reason, 'insufficient-savings')
  assert.equal(highThreshold.refreshCostUsd, baseline.refreshCostUsd)
  const higherChance = decision({ idleContinuationPercent: 50, minExpectedBenefitUsd: 1 })
  assert.equal(higherChance.probability, .5)
  assert.equal(higherChance.worthwhile, true)
  assert.equal(higherChance.expectedSavingsUsd, .5 * higherChance.avoidedMissCostUsd - higherChance.refreshCostUsd)
  assert.equal(decision({ idleContinuationPercent: 0 }, true).probability, 1)
  const exact = decision({ minExpectedBenefitUsd: baseline.expectedSavingsUsd })
  assert.equal(exact.worthwhile, true, 'threshold equality is sufficient')
  assert.equal(decision({ minExpectedBenefitUsd: baseline.expectedSavingsUsd + .000001 }).worthwhile, false)
})

test('zero probability disables idle even with zero threshold and zero prices; missing evidence never bypassed', () => {
  const free = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  assert.equal(decision({ idleContinuationPercent: 0, minExpectedBenefitUsd: 0 }, false, { cost: free }).worthwhile, false)
  assert.equal(decision({ idleContinuationPercent: 0 }).reason, 'idle-probability-zero')
  assert.equal(decision({ minExpectedBenefitUsd: 0 }, false, { usage: { inputTokens: 100, cacheReadTokens: 0 } }).reason, 'no-cache-evidence')
  assert.equal(decision({ minExpectedBenefitUsd: 0 }, false, { cost: null }).reason, 'unknown-pricing')
})

const settings = { autoWarmNewChats: false, activeMinutes: 60, idleMinutes: 30 }
const state = () => ({ sessionId: 's', provider: policy.provider, model: policy.model, retention: 'long',
  transportAvailable: true, storageAvailable: true, cacheTtlMs: policy.cacheTtlMs,
  lastCacheHitAt: 1000, lastRequestAt: 1000, lastRequestFinished: true, lastRequestSnapshot: {},
  agentRunning: false, decision: decision(), nextRefreshAt: 1000 + 27 * MINUTE })

test('simple status states reflect actual scheduling, not economic readiness alone', () => {
  const evaluate = (patch = {}, enabled = true, config = settings, now = 2000) => statusFor({ ...state(), ...patch }, config, enabled, now)
  assert.equal(evaluate().warmingState, 'scheduled')
  assert.equal(evaluate().warmingActive, true)
  assert.equal(evaluate({ nextRefreshAt: null }).warmingState, 'waiting')
  assert.equal(evaluate({ nextRefreshAt: null }).reasonCode, 'decision-pending')
  assert.equal(evaluate({ decision: null }).warmingState, 'waiting')
  assert.equal(evaluate({ nextRefreshAt: null, warming: true }).warmingState, 'warming')
  assert.equal(evaluate({ nextRefreshAt: null, transportPending: true }).warmingState, 'waiting')
  assert.equal(evaluate({ nextRefreshAt: null, transportPending: true }).reasonCode, 'transport-pending')
  assert.equal(evaluate({ decision: decision({ minExpectedBenefitUsd: 1000 }) }).warmingState, 'skipped')
  assert.equal(evaluate({}, false).warmingState, 'disabled')
  assert.equal(evaluate({ decision: decision({ idleContinuationPercent: 0 }) }).warmingState, 'disabled')
  assert.equal(evaluate({ warmFailureCount: 1 }).warmingState, 'stopped')
  assert.equal(evaluate({ nextRefreshAt: null }, true, { ...settings, idleMinutes: 10 }).warmingState, 'stopped')
  assert.equal(evaluate({ nextRefreshAt: null }, true, { ...settings, idleMinutes: 10 }).reasonCode, 'window-too-short')
  assert.equal(evaluate({}, true, settings, 1000 + 30 * MINUTE).warmingState, 'stopped')
  assert.equal(evaluate({ lastRequestSnapshot: null }).warmingState, 'waiting')
  assert.equal(evaluate({ lastRequestFinished: false }).warmingState, 'waiting')
  assert.equal(evaluate({ storageAvailable: false }).warmingState, 'unavailable')
  assert.equal(evaluate({ provider: 'unsupported' }).warmingState, 'unavailable')
  assert.equal(evaluate({ decision: { worthwhile: false, reason: 'unknown-pricing' } }).warmingState, 'unavailable')
  assert.equal(evaluate({ decision: { worthwhile: false, reason: 'no-cache-evidence' } }).warmingState, 'waiting')
  assert.equal(evaluate({ nextRefreshAt: 1000 + 30 * MINUTE }).warmingState, 'waiting', 'timer outside window is not scheduled')
})
