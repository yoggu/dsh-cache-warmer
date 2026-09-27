import { z } from 'zod'
import { nonnegative } from './policy.js'

const usageSchema = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(), cacheWriteTokens: z.number().nonnegative().optional() })

/** Log-derived telemetry only. Request payloads and warm calls never enter this fold. */
export const observations = {
  key: 'dsh-cache-warmer.observations', stateVersion: 1,
  stateSchema: z.object({ provider: z.string().nullable(), model: z.string().nullable(),
    lastCacheHitAt: z.number().nullable(), lastCacheHitTokens: z.number().nullable(),
    usage: usageSchema.nullable(), usageAt: z.number().nullable(), endedAt: z.number().nullable() }),
  init: () => ({ provider: null, model: null, lastCacheHitAt: null, lastCacheHitTokens: null, usage: null, usageAt: null, endedAt: null }),
  apply(state, event) {
    if (event.type === 'request/header' || event.type === 'request/context') {
      const route = event.type === 'request/header' ? event.data.header.config : event.data
      if (event.type === 'request/context' && route.provider === state.provider && route.model === state.model) return state
      return { ...state, provider: route.provider, model: route.model, lastCacheHitAt: null, lastCacheHitTokens: null, usage: null, usageAt: null }
    }
    if (event.surfaceOp && event.surfaceOp !== 'append') return { ...state, lastCacheHitAt: null, lastCacheHitTokens: null, usage: null, usageAt: null }
    if (event.type === 'assistant/message') {
      const u = event.data.usage
      if (!u || event.data.interrupted || !nonnegative(u.inputTokens) || !nonnegative(u.outputTokens)) return state
      if (event.data.message?.source?.provider !== state.provider || event.data.message?.source?.model !== state.model) return state
      const usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens,
        ...(nonnegative(u.cacheReadTokens) ? { cacheReadTokens: u.cacheReadTokens } : {}),
        ...(nonnegative(u.cacheWriteTokens) ? { cacheWriteTokens: u.cacheWriteTokens } : {}) }
      const hit = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > 0
      return { ...state, usage, usageAt: event.time,
        lastCacheHitAt: hit ? event.time : null, lastCacheHitTokens: hit ? usage.cacheReadTokens ?? 0 : null }
    }
    if (event.type === 'turn/end') return { ...state, endedAt: event.time }
    return state
  },
}
