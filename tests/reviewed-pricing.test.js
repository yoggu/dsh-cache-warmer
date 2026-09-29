import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewedOpenRouterPricing } from '../lib/openrouter.js'
import { policyFor, warmingDecision } from '../lib/policy.js'

const id = 'openai/gpt-4.1'
const buckets = ({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) => ({
  input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

test('reviewed shipped pi-ai prices bound exact owner/catalog/version/digest and independently price fresh hypotheticals', () => {
  const price = reviewedOpenRouterPricing(id)
  assert.ok(price)
  assert.equal(price.source.owner, '@deepseek-ai/dsh-llm-pi-ai')
  assert.equal(price.source.catalog, 'openrouter')
  assert.equal(price.source.version, '0.99.1')
  assert.match(price.source.digest, /^[a-f0-9]{64}$/)
  assert.equal(price.fingerprint, `${price.source.version}:${price.source.digest}`)
  assert.equal(price.model.id, id)
  const cached = buckets({ cacheRead: 200_000 })
  const uncached = buckets({ input: 200_000 })
  const first = price.calculateCost(price.model, cached).total
  const second = price.calculateCost(price.model, uncached).total
  assert.ok(second > first)
  assert.equal(cached.cost.total, first)
  assert.equal(uncached.cost.total, second)
  assert.equal(price.calculateCost(price.model, buckets({ cacheRead: 200_000 })).total, first,
    'each hypothetical starts with an empty cost object')
  assert.equal(reviewedOpenRouterPricing('unknown/model'), null)
  assert.equal(reviewedOpenRouterPricing('auto'), null)
})

test('economic decision consumes shipped pi-ai calculateCost, independently from transport permission', () => {
  const price = reviewedOpenRouterPricing(id)
  assert.ok(price)
  const estimate = amount => price.calculateCost(price.model, buckets(amount)).total
  const rule = { provider: 'openrouter', model: id, enabled: true, cacheMinutes: 30 }
  const policy = policyFor(rule.provider, rule.model, { modelPolicies: [rule] })
  const args = { usage: { inputTokens: 1000, cacheReadTokens: 200_000, outputTokens: 200 },
    estimate, policy, active: true }
  const allowed = warmingDecision(args)
  assert.equal(allowed.worthwhile, true)
  assert.deepEqual(warmingDecision({ ...args, policy: { ...policy, transportSupported: false,
    warmingAllowed: false } }), allowed, 'price estimate cannot grant a transport')
  assert.equal(warmingDecision({ ...args, estimate: () => Infinity }).reason, 'unknown-pricing')
  assert.equal(warmingDecision({ ...args, estimate: () => NaN }).reason, 'unknown-pricing')
})
