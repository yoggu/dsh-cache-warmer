import { readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'

export const MINUTE = 60_000
export const SAVINGS_THRESHOLD_USD = .05
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

export function policyFor(provider, model) {
  if (CODEX_ROUTES.has(provider)) return {
    provider, model, kind: 'codex', subscription: true, cacheTtlMs: codexLifetime(model),
    cacheEstimateSource: 'CodexZero model-family estimate; not provider-reported expiry.',
    outputReserve: CODEX_OUTPUT_RESERVE,
  }
  if (provider === 'openrouter' && model === OPENROUTER_MODEL) return {
    provider, model, kind: 'openrouter', subscription: false, cacheTtlMs: null,
    // Verified reuse, but neither route nor backend supplies an expiry guarantee.
    // This is a decision cadence, never presented as an estimated cache lifetime.
    decisionIntervalMs: 5 * MINUTE,
    cacheEstimateSource: 'OpenRouter/DeepSeek expiry is unknown; five-minute best-effort decisions are not a TTL.',
    maxOutputTokens: 8, outputReserve: 8,
  }
  return null
}

/** Use the SAME published pi-ai catalogs as token-cost-estimate, not its accumulated total. */
export function createCatalogReader() {
  const catalogs = new Map()
  return (provider, model) => {
    const catalog = CODEX_ROUTES.has(provider) ? 'openai-codex' : provider
    if (!/^[a-z0-9-]+$/.test(catalog ?? '')) return null
    if (!catalogs.has(catalog)) {
      try {
        const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'))
        const data = JSON.parse(readFileSync(new URL(`./dist/providers/data/${catalog}.json`, pathToFileURL(manifest)), 'utf8'))
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
export function warmingDecision({ usage, cost, policy, active, observedWarmOutput = 0 }) {
  const probability = active ? 1 : .15
  const total = inputSize(usage)
  const rates = total === null ? null : ratesFor(cost, total)
  const base = { probability, thresholdUsd: SAVINGS_THRESHOLD_USD, subscription: policy?.subscription === true,
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
  const worthwhile = expectedSavingsUsd >= SAVINGS_THRESHOLD_USD
  return { ...base, refreshCostUsd, avoidedMissCostUsd, expectedSavingsUsd, worthwhile,
    inputTokens: total, reusableTokens: cached, outputReserve, reason: worthwhile ? 'ready' : 'insufficient-savings' }
}

export function windowEnd(state, settings) {
  if (!nonnegative(state.lastRequestAt)) return null
  return state.lastRequestAt + (state.agentRunning ? settings.activeMinutes : settings.idleMinutes) * MINUTE
}

export function decisionDelay(policy) {
  if (nonnegative(policy?.cacheTtlMs) && policy.cacheTtlMs > 10_000)
    return Math.floor(Math.min(policy.cacheTtlMs * .9, policy.cacheTtlMs - 10_000))
  return nonnegative(policy?.decisionIntervalMs) ? policy.decisionIntervalMs : null
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
