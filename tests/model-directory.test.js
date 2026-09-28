import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelDirectory, modelTransportInfo } from '../lib/model-directory.js'

const inspect = () => ({ transportSupported: false, reasonCode: 'unsupported-provider' })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

test('directory uses every registered route, copies only model metadata and deduplicates', async () => {
  const calls = []
  const directory = createModelDirectory({ llm: {
    listProviders: () => [{ id: 'codex-business', name: 'Work' }, { id: 'deepseek', name: 'DeepSeek' },
      { id: 'custom', name: 'Custom' }, { id: 'deepseek' }, { id: '' }],
    listModels: async provider => {
      calls.push(provider)
      return [{ provider, id: provider === 'codex-business' ? 'gpt-6-astra' : 'model', name: 'Model', privateData: 'not public' },
        { id: 'model', name: 'Other' }, { id: 'model' }, null]
    },
  } }, { inspect })
  const result = await directory.load()
  assert.deepEqual(calls, ['codex-business', 'deepseek', 'custom'])
  assert.equal(result.providers[0].models[0].defaultCacheMinutes, 30)
  assert.equal(result.providers[1].models[0].defaultCacheMinutes, null)
  assert.equal(result.providers[1].models.length, 1)
  assert.equal(result.providers[1].models[0].privateData, undefined)
  assert.equal(JSON.stringify(result).includes('not public'), false)
  assert.equal(result.providers[2].models[0].reasonCode, 'unsupported-provider')
  directory.dispose()
})

test('one failed provider yields partial results without leaking exception text', async () => {
  const directory = createModelDirectory({ llm: {
    listProviders: () => [{ id: 'broken' }, { id: 'healthy' }],
    listModels: async p => { if (p === 'broken') throw new Error('private upstream response'); return [{ id: 'm' }] },
  } }, { inspect })
  const result = await directory.load()
  assert.equal(result.providers[0].error, 'model-discovery-failed')
  assert.equal(result.providers[1].models.length, 1)
  assert.equal(JSON.stringify(result).includes('private'), false)
  directory.dispose()
})

test('concurrent loads coalesce; hanging adapters time out and refresh does not duplicate unresolved work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stalled = deferred(), calls = []
  const directory = createModelDirectory({ llm: {
    listProviders: () => [{ id: 'stall' }, { id: 'healthy' }],
    listModels: async p => { calls.push(p); return p === 'stall' ? stalled.promise : [{ id: 'm' }] },
  } }, { inspect, timeoutMs: 100 })
  const first = directory.load(), second = directory.load()
  await flush()
  assert.deepEqual(calls, ['stall', 'healthy'])
  t.mock.timers.tick(100)
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.equal(a.providers[0].error, 'model-discovery-timeout')
  assert.equal(a.providers[1].models.length, 1)
  const third = directory.load()
  await flush(); t.mock.timers.tick(100); await third
  assert.equal(calls.filter(p => p === 'stall').length, 1)
  stalled.resolve([{ id: 'recovered' }]); await flush()
  const recovered = await directory.load()
  assert.equal(recovered.providers[0].models[0].id, 'recovered')
  assert.equal(calls.filter(p => p === 'stall').length, 2)
  directory.dispose(); t.mock.timers.reset()
})

test('a provider that overruns the deadline is put on cooldown instead of being re-asked', async () => {
  const calls = []
  const ctx = { llm: {
    listProviders: () => [{ id: 'slow' }, { id: 'healthy' }],
    listModels: async p => {
      calls.push(p)
      // Real time: discovery here cannot be cancelled, and the deadline may not
      // even be able to fire while a provider holds the process.
      if (p === 'slow') { await new Promise(resolve => setTimeout(resolve, 40)); return [{ id: 'slow-model' }] }
      return [{ id: 'available' }]
    },
  } }
  const directory = createModelDirectory(ctx, { inspect, timeoutMs: 10 })
  const first = await directory.load()
  assert.deepEqual(calls, ['slow', 'healthy'])
  assert.equal(first.providers[0].error, 'model-discovery-timeout')
  assert.equal(first.providers[1].models[0].id, 'available')

  await new Promise(resolve => setTimeout(resolve, 60))
  const second = await directory.load()
  assert.equal(calls.filter(p => p === 'slow').length, 1, 'a cooling provider is not asked again')
  assert.equal(second.providers[0].error, 'model-discovery-timeout')
  assert.equal(second.providers[0].models.length, 0)
  assert.equal(second.providers[1].models[0].id, 'available')

  directory.invalidate()
  await directory.load()
  assert.equal(calls.filter(p => p === 'slow').length, 1, 'an unrelated adapter update keeps the cooldown')
  directory.dispose()

  const fresh = createModelDirectory(ctx, { inspect, timeoutMs: 10 })
  await fresh.load()
  assert.equal(calls.filter(p => p === 'slow').length, 2, 'a fresh instance starts with a clean slate')
  fresh.dispose()
})

test('a catalog of many models reads each provider route once per pass', async () => {
  // The route read walks the plugin registry and the whole settings projection.
  // Repeating it per model held the Host for ~19 s on a 386-model catalog, so
  // one pass must read it exactly once per provider and share that view.
  const calls = { entries: 0, described: 0, registered: 0 }
  const models = ['openai/gpt-4.1', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct', 'anthropic/claude-sonnet-4.5:batch']
  const ctx = {
    get: name => ({
      configEditor: { entries: () => { calls.entries++; return [{ options: { id: 'pi', name: '@deepseek-ai/dsh-llm-pi-ai' }, fiber: { state: 2 } }] } },
      settings: { describe: () => { calls.described++; return [{ ns: 'pi', revision: 1, value: { providers: { openrouter: { apiKeyEnv: 'TEST_OPENROUTER_KEY' } } } }] } },
      credentials: {},
      llm: { listProviders: () => { calls.registered++; return [{ id: 'openrouter' }] } },
    })[name],
  }
  const directory = createModelDirectory({ ...ctx, llm: {
    listProviders: () => { calls.registered++; return [{ id: 'openrouter' }] },
    listModels: async provider => models.map(id => ({ provider, id, name: id })),
  } })
  const result = await directory.load()
  assert.deepEqual(calls, { entries: 1, described: 1, registered: 1 })
  assert.equal(result.providers[0].models.length, models.length)
  assert.deepEqual([...new Set(result.providers[0].models.map(m => m.reasonCode))], [null], 'every catalog model is admitted in one pass')
  directory.dispose()
})

test('provider lookup failure is safe and disposal ends pending UI waits', async () => {
  const broken = createModelDirectory({ llm: { listProviders: () => { throw new Error('private') } } }, { inspect })
  assert.deepEqual(await broken.load(), { providers: [], error: 'provider-discovery-failed' })
  broken.dispose()
  const stalled = createModelDirectory({ llm: { listProviders: () => [{ id: 'p' }], listModels: () => new Promise(() => {}) } }, { inspect })
  const work = stalled.load()
  await flush(); stalled.dispose()
  await work
  assert.deepEqual(await stalled.load(), { providers: [], error: 'provider-discovery-failed' })
})

test('stalled providers cannot starve healthy models later in the registry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const directory = createModelDirectory({ llm: {
    listProviders: () => [...Array.from({ length: 6 }, (_, i) => ({ id: `stalled-${i}` })), { id: 'healthy' }],
    listModels: async p => p === 'healthy' ? [{ id: 'available' }] : new Promise(() => {}),
  } }, { inspect, timeoutMs: 100 })
  const work = directory.load()
  await flush(); t.mock.timers.tick(100)
  const result = await work
  assert.equal(result.providers[6].models[0].id, 'available')
  assert.ok(result.providers.slice(0, 6).every(p => p.error === 'model-discovery-timeout'))
  directory.dispose(); t.mock.timers.reset()
})

test('adapter replacement invalidates a hanging same-id lookup without accepting its stale result', async () => {
  const stalled = deferred()
  let replaced = false, calls = 0
  const directory = createModelDirectory({ llm: {
    listProviders: () => [{ id: 'same-route' }],
    listModels: async () => { calls++; return replaced ? [{ id: 'new-model' }] : stalled.promise },
  } }, { inspect })
  const old = directory.load()
  await flush(); replaced = true; directory.invalidate()
  const fresh = await directory.load()
  assert.equal(fresh.providers[0].models[0].id, 'new-model')
  assert.equal(calls, 2)
  assert.equal((await old).error, 'provider-discovery-failed')
  stalled.resolve([{ id: 'stale-model' }]); await flush()
  assert.equal((await directory.load()).providers[0].models[0].id, 'new-model')
  directory.dispose()
})

test('capability metadata distinguishes unsupported providers and missing configured routes', () => {
  const ctx = { get: () => undefined }
  assert.deepEqual(modelTransportInfo(ctx, 'deepseek', 'deepseek-chat'), { transportSupported: false, reasonCode: 'unsupported-provider' })
  assert.deepEqual(modelTransportInfo(ctx, 'codex-business', 'gpt-6-astra'), { transportSupported: false, reasonCode: 'route-unavailable' })
  assert.deepEqual(modelTransportInfo(ctx, 'openrouter', 'unknown/model'), { transportSupported: false, reasonCode: 'unsupported-model' })
})
