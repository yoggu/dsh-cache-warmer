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

test('capability metadata distinguishes unsupported providers and missing configured routes', () => {
  const ctx = { get: () => undefined }
  assert.deepEqual(modelTransportInfo(ctx, 'deepseek', 'deepseek-chat'), { transportSupported: false, reasonCode: 'unsupported-provider' })
  assert.deepEqual(modelTransportInfo(ctx, 'codex-business', 'gpt-6-astra'), { transportSupported: false, reasonCode: 'route-unavailable' })
  assert.deepEqual(modelTransportInfo(ctx, 'openrouter', 'unknown/model'), { transportSupported: false, reasonCode: 'unsupported-model' })
})
