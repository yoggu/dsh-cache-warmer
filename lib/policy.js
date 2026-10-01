import { openRouterModelSupport } from './openrouter.js'

export const MINUTE = 60_000
export const SAVINGS_THRESHOLD_USD = .05
export const IDLE_CONTINUATION_PERCENT = 15

/** Strict settings validation shared by config, HTTP and decision calculation. */
export function normalizeCostChecks(settings = {}) {
  const minExpectedBenefitUsd = settings.minExpectedBenefitUsd === undefined ? SAVINGS_THRESHOLD_USD : settings.minExpectedBenefitUsd
  const idleContinuationPercent = settings.idleContinuationPercent === undefined ? IDLE_CONTINUATION_PERCENT : settings.idleContinuationPercent
  if (typeof minExpectedBenefitUsd !== 'number' || !Number.isFinite(minExpectedBenefitUsd)
    || minExpectedBenefitUsd < 0 || minExpectedBenefitUsd > 1000)
    throw new TypeError('minExpectedBenefitUsd must be a finite number from 0 to 1000')
  if (!Number.isInteger(idleContinuationPercent) || idleContinuationPercent < 0 || idleContinuationPercent > 100)
    throw new TypeError('idleContinuationPercent must be an integer from 0 to 100')
  return { minExpectedBenefitUsd, idleContinuationPercent }
}
export const OPENROUTER_MODEL = '~deepseek/deepseek-v4-flash-latest'
export const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

const MODEL_POLICY_KEYS = new Set(['provider', 'model', 'enabled', 'cacheMinutes', 'shortMinutes', 'longMinutes'])
const MAX_MODEL_POLICIES = 100
const MAX_POLICY_MINUTES = 10080

/**
 * Canonical, exact-match user rules with one estimate for both retention modes.
 * Legacy tiers migrate to the shorter estimate only when both are known, never
 * lengthening either tier or enabling an unknown one. Missing minutes mean
 * unknown. These are planning estimates, not provider TTL settings; accepting
 * a row does not enable its transport.
 */
export function normalizeModelPolicies(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_MODEL_POLICIES)
    throw new TypeError('modelPolicies must be an array of at most 100 rows')
  const seen = new Set()
  return Array.from(value, (row, index) => {
    const fail = message => { throw new TypeError(`modelPolicies[${index}]: ${message}`) }
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(row))) fail('must be a plain object')
    if (Reflect.ownKeys(row).some(key => !MODEL_POLICY_KEYS.has(key))) fail('unknown field')
    if (['provider', 'model', 'enabled'].some(key => !Object.hasOwn(row, key))) fail('provider, model and enabled are required')
    const { provider, model, enabled } = row
    if (typeof provider !== 'string' || !provider.length || provider.length > 128 || provider !== provider.trim()
      || !/^[A-Za-z0-9_.-]+$/.test(provider)) fail('provider must be an exact id (1–128 letters, digits, _, . or -)')
    if (typeof model !== 'string' || !model.length || model.length > 256 || model !== model.trim()
      || /[*?\[\]{}]/.test(model)) fail('model must be an exact id (1–256 characters, no wildcards or surrounding whitespace)')
    if (typeof enabled !== 'boolean') fail('enabled must be a boolean')
    const minutes = key => {
      const n = row[key]
      if (n === undefined || n === null) return null
      if (!Number.isInteger(n) || n < 1 || n > MAX_POLICY_MINUTES) fail(`${key} must be null or an integer from 1 to 10080`)
      return n
    }
    const legacy = Object.hasOwn(row, 'shortMinutes') || Object.hasOwn(row, 'longMinutes')
    if (legacy && Object.hasOwn(row, 'cacheMinutes')) fail('cacheMinutes cannot be mixed with legacy shortMinutes or longMinutes')
    let cacheMinutes
    if (legacy) {
      const short = minutes('shortMinutes'), long = minutes('longMinutes')
      cacheMinutes = short === null || long === null ? null : Math.min(short, long)
    } else cacheMinutes = minutes('cacheMinutes')
    const canonical = { provider, model, enabled, cacheMinutes }
    const key = JSON.stringify([provider, model])
    if (seen.has(key)) fail('duplicate provider/model pair')
    seen.add(key)
    return canonical
  })
}

/**
 * Exact custom rules apply to BOTH retention modes with one estimate,
 * including nulls and disabled entries. There are no implicit provider lifetimes.
 * Callers must pass the retention tier actually used by the captured request;
 * the long default preserves pure callers, not a guess for a missing live tier.
 */
export function policyFor(provider, model, settings = {}, retention = 'long', capability = null) {
  const custom = normalizeModelPolicies(settings?.modelPolicies)
    .find(row => row.provider === provider && row.model === model)
  const openrouter = provider === 'openrouter'
  if (!openrouter && !custom && !capability?.owned) return null
  const transportSupported = capability?.owned
    ? capability.supported === true : openrouter && openRouterModelSupport(model).supported
  const knownTier = retention === 'short' || retention === 'long'
  const ruleSource = custom ? 'custom' : 'unknown'
  const customMinutes = custom?.cacheMinutes ?? null
  // Observation-only routes do not expose a retention tier. Their explicit
  // local estimate still drives the display, never a warming permission.
  const displayEstimate = knownTier || ((!openrouter || capability?.owned) && retention === 'unknown')
  const cacheTtlMs = displayEstimate && customMinutes !== null ? customMinutes * MINUTE : null
  const cacheEstimateSource = custom
    ? 'User-configured lifetime estimate shared by short and long retention; not provider-reported expiry or a TTL-setting request.'
    : 'No configured or reviewed cache-lifetime estimate for this model and retention tier.'
  return {
    provider, model, kind: capability?.owned ? 'pi-ai' : openrouter ? 'openrouter' : 'unsupported', subscription: provider === 'openai-codex',
    warmingAllowed: transportSupported && custom?.enabled === true
      && (capability?.outputBound !== 'client' || settings.allowClientBoundWarming === true),
    clientBoundConsentRequired: capability?.owned && capability.outputBound === 'client' && settings.allowClientBoundWarming !== true,
    transportSupported, retention, ruleSource, cacheTtlMs, cacheEstimateSource,
    maxOutputTokens: capability?.owned ? capability.maxOutputTokens ?? 256 : 8,
    outputReserve: capability?.owned ? capability.outputReserve ?? 256 : 8,
    extraInputTokens: capability?.owned ? 64 : 0,
    outputBound: capability?.owned ? capability.outputBound ?? 'client' : 'server',
  }
}

export function inputSize(usage) {
  if (!usage || !nonnegative(usage.inputTokens)) return null
  const counts = [usage.inputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]
  return counts.every(nonnegative) ? counts.reduce((a, b) => a + b, 0) : null
}

/** Pi-style economics, conservatively credit only observed reusable tokens. */
export function warmingDecision({ usage, estimate, policy, active, observedWarmOutput = 0, settings = {} }) {
  const { minExpectedBenefitUsd, idleContinuationPercent } = normalizeCostChecks(settings)
  const probability = active ? 1 : idleContinuationPercent / 100
  const total = inputSize(usage)
  const base = { probability, thresholdUsd: minExpectedBenefitUsd, subscription: policy?.subscription === true,
    expectedSavingsUsd: null, refreshCostUsd: null, avoidedMissCostUsd: null, worthwhile: false }
  if (total === null || total === 0) return { ...base, reason: 'no-context' }
  if (typeof estimate !== 'function') return { ...base, reason: 'unknown-pricing' }
  const cached = Math.min(total, (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
  if (cached <= 0) return { ...base, reason: 'no-cache-evidence' }
  const outputReserve = Math.max(policy?.outputReserve ?? 8, observedWarmOutput)
  let refreshCostUsd, hitCostUsd, missCostUsd
  try {
    // Every hypothetical uses pi-ai's exact request-wide tier selection. With
    // cacheWrite=0, a miss is charged as uncached input, never as free input.
    refreshCostUsd = estimate({ cacheRead: cached, input: total - cached + (policy?.extraInputTokens ?? 0), output: outputReserve })
    hitCostUsd = estimate({ cacheRead: cached })
    const uncachedMissUsd = estimate({ input: cached })
    const writeMissUsd = estimate({ cacheWrite: cached })
    // Some providers bill a cache creation, others ordinary input. Credit
    // only the cheaper possibility; no unknown charge may inflate savings.
    missCostUsd = writeMissUsd > 0 ? Math.min(uncachedMissUsd, writeMissUsd) : uncachedMissUsd
  } catch { return { ...base, reason: 'unknown-pricing' } }
  if (![refreshCostUsd, hitCostUsd, missCostUsd].every(nonnegative))
    return { ...base, reason: 'unknown-pricing' }
  const avoidedMissCostUsd = Math.max(0, missCostUsd - hitCostUsd)
  const expectedSavingsUsd = probability * avoidedMissCostUsd - refreshCostUsd
  if (![avoidedMissCostUsd, expectedSavingsUsd].every(Number.isFinite))
    return { ...base, reason: 'unknown-pricing' }
  const worthwhile = probability > 0 && expectedSavingsUsd >= minExpectedBenefitUsd
  return { ...base, refreshCostUsd, avoidedMissCostUsd, expectedSavingsUsd, worthwhile,
    inputTokens: total, reusableTokens: cached, outputReserve,
    reason: worthwhile ? 'ready' : probability === 0 ? 'idle-probability-zero' : 'insufficient-savings' }
}

export function windowEnd(state, settings) {
  if (!nonnegative(state.lastRequestAt)) return null
  return state.lastRequestAt + (state.agentRunning ? settings.activeMinutes : settings.idleMinutes) * MINUTE
}

export function decisionDelay(policy) {
  if (policy?.warmingAllowed === false || policy?.transportSupported === false) return null
  if (nonnegative(policy?.cacheTtlMs) && policy.cacheTtlMs > 10_000)
    return Math.floor(Math.min(policy.cacheTtlMs * .9, policy.cacheTtlMs - 10_000))
  return null
}

export function nextDecisionAt(state, enabled, settings, policy, now = Date.now()) {
  const delay = decisionDelay(policy)
  const end = windowEnd(state, settings)
  const base = state.lastWarmAt ?? state.lastRequestAt
  if (!enabled || delay === null || !nonnegative(base) || end === null || now >= end
    || state.warmFailureCount > 0 || state.decisionStopped) return null
  // Do not pay to recreate an already elapsed estimated cache on a delayed timer.
  if (nonnegative(policy.cacheTtlMs) && nonnegative(state.lastCacheHitAt)
    && now >= state.lastCacheHitAt + policy.cacheTtlMs) return null
  const due = Math.max(now, base + delay)
  return due < end ? due : null
}
