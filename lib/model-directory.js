import { CODEX_ROUTES, MINUTE, codexLifetime } from './policy.js'
import { readCodexRoute } from './codex.js'
import { readOpenRouterRoute, openRouterModelSupport } from './openrouter.js'

/** Capability inspection only: never reads credentials or issues inference. */
export function modelTransportInfo(ctx, provider, model) {
  try {
    if (CODEX_ROUTES.has(provider)) {
      const route = readCodexRoute(ctx, provider, model, { allowDisabled: true })
      return route.cacheRetention === 'none'
        ? { transportSupported: false, reasonCode: 'retention-disabled' }
        : { transportSupported: true, reasonCode: null }
    }
    if (provider === 'openrouter') {
      const support = openRouterModelSupport(model)
      if (!support.supported) return { transportSupported: false, reasonCode: support.reasonCode }
      const route = readOpenRouterRoute(ctx)
      return route.cacheRetention === 'none'
        ? { transportSupported: false, reasonCode: 'retention-disabled' }
        : { transportSupported: true, reasonCode: null }
    }
    return { transportSupported: false, reasonCode: 'unsupported-provider' }
  } catch {
    return { transportSupported: false, reasonCode: 'route-unavailable' }
  }
}

/**
 * Read the unified adapter registry, not plugin names or credential stores.
 * listModels has no cancellation parameter. Retain each unresolved operation
 * across refreshes so a stalled adapter cannot accumulate duplicate work.
 * Adapter/settings invalidation starts a new generation; stale results never
 * replace current metadata. The deadline bounds UI waiting, not adapter work.
 */
export function createModelDirectory(ctx, { timeoutMs = 5000,
  inspect = (provider, model) => modelTransportInfo(ctx, provider, model) } = {}) {
  const pending = new Map(), waits = new Set()
  let disposed = false, inFlight, generation = 0
  const safeString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  const modelsFor = provider => {
    if (!pending.has(provider)) {
      const work = Promise.resolve().then(() => ctx.llm.listModels(provider))
        .then(models => ({ models }), () => ({ error: 'model-discovery-failed' }))
      pending.set(provider, work)
      void work.then(() => { if (pending.get(provider) === work) pending.delete(provider) })
    }
    return pending.get(provider)
  }
  const load = async () => {
    if (disposed) return { providers: [], error: 'provider-discovery-failed' }
    if (inFlight) return inFlight
    const currentGeneration = generation
    const work = (async () => {
      let routes
      try { routes = ctx.llm.listProviders() } catch { return { providers: [], error: 'provider-discovery-failed' } }
      if (!Array.isArray(routes)) return { providers: [], error: 'provider-discovery-failed' }
      const seen = new Set()
      routes = routes.filter(route => safeString(route?.id, 128) && !seen.has(route.id) && seen.add(route.id))
      const providers = new Array(routes.length)
      let expired = false, finish
      const timeout = new Promise(resolve => { finish = () => { expired = true; resolve({ error: 'model-discovery-timeout' }) } })
      const timer = setTimeout(finish, timeoutMs)
      waits.add(finish)
      try {
        // Each registered route gets the same deadline. A hung provider must
        // not starve unrelated providers queued behind it.
        await Promise.all(routes.map(async (route, index) => {
          const base = { id: route.id, name: safeString(route.name, 256) ? route.name : route.id, models: [] }
          providers[index] = base
          const result = expired ? { error: 'model-discovery-timeout' } : await Promise.race([modelsFor(route.id), timeout])
          if (disposed || currentGeneration !== generation) return
          if (result.error || !Array.isArray(result.models)) {
            base.error = result.error ?? 'model-discovery-failed'
            return
          }
          const ids = new Set()
          for (const model of result.models) {
            if (!safeString(model?.id, 256) || ids.has(model.id)) continue
            ids.add(model.id)
            // Copy only public model identity; descriptions, adapter payloads and
            // error text never escape into a settings response.
            const ttl = CODEX_ROUTES.has(route.id) ? codexLifetime(model.id) : null
            let capability
            try { capability = inspect(route.id, model.id) }
            catch { capability = { transportSupported: false, reasonCode: 'route-unavailable' } }
            base.models.push({ id: model.id, name: safeString(model.name, 256) ? model.name : model.id,
              defaultCacheMinutes: ttl === null ? null : ttl / MINUTE,
              transportSupported: capability.transportSupported === true,
              reasonCode: capability.reasonCode ?? null })
          }
        }))
        if (disposed || currentGeneration !== generation) return { providers: [], error: 'provider-discovery-failed' }
        return { providers: providers.filter(Boolean) }
      } finally { clearTimeout(timer); waits.delete(finish) }
    })()
    inFlight = work
    try { return await work } finally { if (inFlight === work) inFlight = undefined }
  }
  const invalidate = () => {
    generation++; inFlight = undefined
    for (const finish of waits) finish()
    pending.clear()
  }
  return { load, invalidate, dispose() { disposed = true; invalidate() } }
}
