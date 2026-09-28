/**
 * One discovery pass's memo for route lookups.
 *
 * Reading a route walks the plugin registry and the whole settings projection,
 * which is far too heavy to repeat for every model a provider reports: one
 * catalog can hold hundreds of models, and repeating that read for each of them
 * blocks the Host for many seconds. A single cache per pass also gives the whole
 * catalog one consistent view of the configuration it was built from.
 *
 * Failures are memoized too: a route that is unavailable is unavailable for
 * every model in the same pass, and the original rejection reason is rethrown
 * so callers keep their reason codes.
 *
 * @returns the read-through `(key, read)` function a route reader accepts.
 */
export function routeCache() {
  const entries = new Map()
  return (key, read) => {
    if (!entries.has(key)) {
      try {
        entries.set(key, { value: read() })
      } catch (failure) {
        entries.set(key, { failure })
      }
    }
    const entry = entries.get(key)
    if ('failure' in entry) throw entry.failure
    return entry.value
  }
}
