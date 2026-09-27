import { readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'
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
export const CODEX_OUTPUT_RESERVE = 1024 // Heuristic, NOT a provider-enforced output cap.
export const CODEX_ROUTES = new Set(['codex-personal', 'codex-business'])
export const OPENROUTER_MODEL = '~deepseek/deepseek-v4-flash-latest'
export const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Reviewed family estimates from CodexZero; never extrapolate to a new major family. */
export function codexLifetime(model) {
  if (typeof model !== 'string') return null
  if (/^(gpt-6-(astra|sol|luna)|gpt-5\.6(?:-[a-z0-9-]+)?|gpt-5\.5(?:-[a-z0-9-]+)?|gpt-daybreak-blue-latest)$/.test(model)) return 30 * MINUTE
  if (/^gpt-5(?:\.[0-4])?(?:-codex(?:-(?:mini|max))?)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return 5 * MINUTE
  return null
}

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
 * Exact custom rules replace the reviewed defaults for BOTH retention modes
 * with one estimate, including nulls and disabled entries. CodexZero estimates are a
 * fallback only, and are not server-reported or tier-specific guarantees.
 * Callers must pass the retention tier actually used by the captured request;
 * the long default preserves pure callers, not a guess for a missing live tier.
 */
export function policyFor(provider, model, settings = {}, retention = 'long') {
  const custom = normalizeModelPolicies(settings?.modelPolicies)
    .find(row => row.provider === provider && row.model === model)
  const codex = CODEX_ROUTES.has(provider)
  const openrouter = provider === 'openrouter'
  if (!codex && !openrouter && !custom) return null
  const transportSupported = codex || (openrouter && openRouterModelSupport(model).supported)
  const builtInTtl = codex && settings?.useCodexDefaults !== false ? codexLifetime(model) : null
  const knownTier = retention === 'short' || retention === 'long'
  const ruleSource = custom ? 'custom' : builtInTtl !== null ? 'codex-default' : 'unknown'
  const customMinutes = custom?.cacheMinutes ?? null
  const cacheTtlMs = !knownTier ? null : custom
    ? customMinutes === null ? null : customMinutes * MINUTE
    : builtInTtl
  const cacheEstimateSource = custom
    ? 'User-configured lifetime estimate shared by short and long retention; not provider-reported expiry or a TTL-setting request.'
    : ruleSource === 'codex-default'
      ? 'CodexZero model-family estimate; not provider-reported expiry or a tier-specific guarantee.'
      : 'No configured or reviewed cache-lifetime estimate for this model and retention tier.'
  return {
    provider, model, kind: codex ? 'codex' : openrouter ? 'openrouter' : 'unsupported', subscription: codex,
    warmingAllowed: custom ? custom.enabled : builtInTtl !== null,
    transportSupported, retention, ruleSource, cacheTtlMs, cacheEstimateSource,
    ...(codex ? { outputReserve: CODEX_OUTPUT_RESERVE }
      : { maxOutputTokens: 8, outputReserve: 8 }),
  }
}

function readCatalog(catalog) {
  const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'))
  return JSON.parse(readFileSync(new URL(`./dist/providers/data/${catalog}.json`, pathToFileURL(manifest)), 'utf8'))
}

let codexDefaultRows
/**
 * Read-only examples for "customize defaults": concrete catalog ids filtered
 * through the reviewed CodexZero families, never wildcard rules. One estimate
 * applies to both retention modes (no separate tier lifetime is claimed).
 * If the installed catalog is unavailable, use reviewed illustrative ids only.
 */
export function defaultModelPolicies() {
  if (codexDefaultRows) return codexDefaultRows
  let ids
  try {
    const data = readCatalog('openai-codex')
    ids = [...new Set(Object.values(data).flatMap(group => Object.entries(group ?? {})
      .filter(([id, entry]) => (!entry.provider || entry.provider === 'openai-codex') && codexLifetime(id) !== null)
      .map(([id]) => id)))].sort()
  } catch {
    ids = ['gpt-5-codex', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol']
  }
  // Keep the complete example list importable under the same 100-row limit.
  ids = ids.slice(0, Math.floor(MAX_MODEL_POLICIES / CODEX_ROUTES.size))
  codexDefaultRows = Object.freeze([...CODEX_ROUTES].flatMap(provider => ids.map(model => Object.freeze({
    provider, model, enabled: true, cacheMinutes: codexLifetime(model) / MINUTE,
  }))))
  return codexDefaultRows
}

/** Use the SAME published pi-ai catalogs as token-cost-estimate, not its accumulated total. */
export function createCatalogReader() {
  const catalogs = new Map()
  return (provider, model) => {
    const catalog = CODEX_ROUTES.has(provider) ? 'openai-codex' : provider
    if (!/^[a-z0-9-]+$/.test(catalog ?? '')) return null
    if (!catalogs.has(catalog)) {
      try {
        const data = readCatalog(catalog)
        const models = new Map()
        for (const group of Object.values(data)) for (const [id, entry] of Object.entries(group ?? {})) {
          if (entry?.cost && (!entry.provider || entry.provider === catalog)) models.set(id, entry.cost)
        }
        catalogs.set(catalog, models)
      } catch { catalogs.set(catalog, new Map()) }
    }
    return catalogs.get(catalog).get(model) ?? null
  }
}

/** Rates per token. Tier boundaries use the COMPLETE input, cached plus uncached. */
export function ratesFor(cost, inputTokens) {
  if (!cost || !nonnegative(inputTokens)) return null
  let rate = cost
  let threshold = -1
  for (const tier of cost.tiers ?? []) if (nonnegative(tier.inputTokensAbove)
    && inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
    rate = { ...cost, ...tier }; threshold = tier.inputTokensAbove
  }
  if (![rate.input, rate.output, rate.cacheRead].every(nonnegative)) return null
  return { input: rate.input / 1e6, output: rate.output / 1e6, cacheRead: rate.cacheRead / 1e6,
    cacheWrite: nonnegative(rate.cacheWrite) ? rate.cacheWrite / 1e6 : 0 }
}

export function inputSize(usage) {
  if (!usage || !nonnegative(usage.inputTokens)) return null
  const counts = [usage.inputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]
  return counts.every(nonnegative) ? counts.reduce((a, b) => a + b, 0) : null
}

export function usageCost(usage, cost) {
  const total = inputSize(usage)
  const rates = total === null ? null : ratesFor(cost, total)
  if (!rates || !nonnegative(usage.outputTokens)) return null
  return usage.inputTokens * rates.input + (usage.cacheReadTokens ?? 0) * rates.cacheRead
    + (usage.cacheWriteTokens ?? 0) * rates.cacheWrite + usage.outputTokens * rates.output
}

/** Pi-style economics, conservatively credit only observed reusable tokens. */
export function warmingDecision({ usage, cost, policy, active, observedWarmOutput = 0, settings = {} }) {
  const { minExpectedBenefitUsd, idleContinuationPercent } = normalizeCostChecks(settings)
  const probability = active ? 1 : idleContinuationPercent / 100
  const total = inputSize(usage)
  const rates = total === null ? null : ratesFor(cost, total)
  const base = { probability, thresholdUsd: minExpectedBenefitUsd, subscription: policy?.subscription === true,
    expectedSavingsUsd: null, refreshCostUsd: null, avoidedMissCostUsd: null, worthwhile: false }
  if (total === null || total === 0) return { ...base, reason: 'no-context' }
  if (!rates) return { ...base, reason: 'unknown-pricing' }
  const cached = Math.min(total, (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
  if (cached <= 0) return { ...base, reason: 'no-cache-evidence' }
  const outputReserve = Math.max(policy?.outputReserve ?? 8, observedWarmOutput)
  // The Codex appended keep-alive suffix is conservatively reserved as 64 uncached tokens.
  const suffix = policy?.kind === 'codex' ? 64 : 0
  const refreshCostUsd = cached * rates.cacheRead + (total - cached + suffix) * rates.input + outputReserve * rates.output
  const avoidedMissCostUsd = Math.max(0, cached * ((rates.cacheWrite || rates.input) - rates.cacheRead))
  const expectedSavingsUsd = probability * avoidedMissCostUsd - refreshCostUsd
  // Zero idle probability is an explicit no-continuation assumption, including
  // free catalogs where zero expected cost would otherwise pass a zero threshold.
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
