import { MINUTE } from './policy.js'
import { readOpenRouterRoute, openRouterModelSupport } from './openrouter.js'
import { routeCache } from './route-cache.js'
import { piAiRouteInfo } from './pi-ai.js'

/**
 * Capability inspection only: never reads credentials or issues inference.
 * @param ctx - the plugin's Cordis context.
 * @param provider - the registered route.
 * @param model - the model to classify.
 * @param cached - optional per-pass memo, so a catalog of hundreds of models
 *   reads its route once instead of once per model.
 */
export function modelTransportInfo(ctx, provider, model, cached = (key, read) => read()) {
  try {
    const native = piAiRouteInfo(ctx, provider, model)
    if (native.owned) return { transportSupported: native.supported === true,
      reasonCode: native.reasonCode ?? null, outputBound: native.outputBound ?? 'client' }
    if (provider === 'openrouter') {
      const support = openRouterModelSupport(model)
      if (!support.supported) return { transportSupported: false, reasonCode: support.reasonCode }
      const route = readOpenRouterRoute(ctx, cached)
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
 * How long a provider that blew the discovery deadline is left alone.
 *
 * Some routes discover their models through work that can take many seconds —
 * a local inference server, a slow gateway — and that work runs before this
 * plugin sees anything, so waiting cannot be cancelled from here. Re-asking on
 * every settings open would make the whole Harness wait with it, so such a
 * provider is reported as timed out without being asked again until the
 * adapter registry changes (which invalidates the directory and clears this).
 */
const SLOW_PROVIDER_COOLDOWN_MS = 30 * MINUTE

/**
 * Read the unified adapter registry, not plugin names or credential stores.
 * listModels has no cancellation parameter. Retain each unresolved operation
 * across refreshes so a stalled adapter cannot accumulate duplicate work.
 * Adapter/settings invalidation starts a new generation; stale results never
 * replace current metadata. The deadline bounds UI waiting, not adapter work.
 */
export function createModelDirectory(ctx, { timeoutMs = 5000, inspect } = {}) {
  const pending = new Map(), waits = new Set(), slowUntil = new Map()
  let disposed = false, inFlight, generation = 0
  const safeString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  const cooling = provider => (slowUntil.get(provider) ?? 0) > Date.now()
  const modelsFor = provider => {
    if (!pending.has(provider)) {
      const started = Date.now()
      const work = Promise.resolve().then(() => ctx.llm.listModels(provider))
        .then(models => ({ models }), () => ({ error: 'model-discovery-failed' }))
        .then(result => {
          // The deadline may not have been able to fire while the provider was
          // busy, so a slow answer is recognized by its own duration.
          if (Date.now() - started > timeoutMs) slowUntil.set(provider, Date.now() + SLOW_PROVIDER_COOLDOWN_MS)
          return result
        })
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
      // One route read per provider for this pass: the settings projection and
      // the plugin registry are read once, not once per discovered model.
      const cached = routeCache()
      const capabilityOf = inspect ?? ((provider, model) => modelTransportInfo(ctx, provider, model, cached))
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
          if (cooling(route.id)) { base.error = 'model-discovery-timeout'; return }
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
            const ttl = null // No default cache lifetime for observation-only routes.
            let capability
            try { capability = capabilityOf(route.id, model.id) }
            catch { capability = { transportSupported: false, reasonCode: 'route-unavailable' } }
            base.models.push({ id: model.id, name: safeString(model.name, 256) ? model.name : model.id,
              defaultCacheMinutes: ttl === null ? null : ttl / MINUTE,
              transportSupported: capability.transportSupported === true,
              reasonCode: capability.reasonCode ?? null,
              ...(capability.outputBound ? { outputBound: capability.outputBound } : {}) })
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
    // A route that changed may be quick now, but `llm/adapters-updated` also
    // fires for reasons unrelated to any one route, so a cooldown survives
    // invalidation and expires on its own clock instead.
    pending.clear()
  }
  return { load, invalidate, dispose() { disposed = true; invalidate() } }
}
