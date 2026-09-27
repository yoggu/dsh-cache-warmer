import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as localLlm from '@deepseek-ai/dsh-llm'
import { resolveRequestIdentity } from '../lib/request-identity.js'

// Follow the installed pi-ai adapter's dependency resolution, as production does
// for its catalog. No machine-specific path, provider request, or credentials.
const hostAnchor = realpathSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai')))
const hostRequire = createRequire(hostAnchor)
const hostLlm = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')).href)
const { Context: HostContext } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href)
const localAnchor = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm'))
const localRequire = createRequire(localAnchor)
const { Context: LocalContext } = await import(pathToFileURL(localRequire.resolve('@deepseek-ai/cordis')).href)

async function mountedRuntime(t, api, Context) {
  const ctx = new Context()
  const owner = ctx.plugin(api.LlmRuntime)
  await owner.await()
  let injected
  const probe = ctx.plugin({
    name: 'cache-warmer-request-identity-test',
    inject: ['llm'],
    apply(c) { injected = c },
  })
  await probe.await()
  t.after(async () => { await probe.dispose(); await owner.dispose() })
  assert.ok(injected, 'probe must be an actual injected Cordis plugin')
  return { ctx, injected, runtime: injected.llm }
}

function request(config = {}) {
  return Object.freeze({
    provider: 'offline-identity-fixture', model: 'synthetic', ...config,
    sessionId: 'offline-identity-session',
    messages: Object.freeze([]), signal: new AbortController().signal,
  })
}

test('request identity accepts the matching local runtime through its injected Cordis proxy', async t => {
  const { runtime } = await mountedRuntime(t, localLlm, LocalContext)
  assert.ok(runtime instanceof localLlm.LlmRuntime)
  const predicate = await resolveRequestIdentity(runtime, null)
  assert.equal(predicate, localLlm.isAgentLoopRequest)
  const options = localLlm.markAgentLoopRequest(request())
  assert.equal(predicate(options), true)
  assert.equal(predicate(Object.freeze({ ...options })), false, 'a frozen exact clone is still not a LOOP request')
})

test('installed prepared-call waterfall uses the owning runtime marker across peer copies', async t => {
  if (hostLlm.LlmRuntime === localLlm.LlmRuntime) {
    t.skip('installed runtime is deduplicated with the plugin; cross-copy fixture requires distinct peers')
    return
  }
  const { ctx, injected, runtime } = await mountedRuntime(t, hostLlm, HostContext)
  assert.ok(runtime instanceof hostLlm.LlmRuntime, 'Cordis proxy must retain public instanceof identity')
  assert.equal(runtime instanceof localLlm.LlmRuntime, false)
  const predicate = await resolveRequestIdentity(runtime, hostAnchor)
  assert.equal(predicate, hostLlm.isAgentLoopRequest)

  let dispatched = 0
  class OfflineAdapter extends hostLlm.LlmAdapter {
    async *stream() {
      dispatched++
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const unregister = ctx.llm.registerAdapter(['offline-identity-fixture'], new OfflineAdapter())
  t.after(unregister)
  const prepared = await runtime.prepareCall({ provider: 'offline-identity-fixture', model: 'synthetic' })
  const options = hostLlm.markAgentLoopRequest(request(prepared.config))
  assert.equal(localLlm.isAgentLoopRequest(options), false, 'reproduce the former capture rejection')
  assert.equal(predicate(options), true)
  assert.equal(predicate(localLlm.markAgentLoopRequest(request(prepared.config))), false)
  assert.equal(predicate(Object.freeze({ ...options })), false)

  let observed = 0
  injected.on('llm/stream', (actual, next) => {
    observed++
    assert.equal(actual, options, 'preparedCall must preserve request object identity before middleware')
    assert.equal(predicate(actual), true)
    assert.equal(localLlm.isAgentLoopRequest(actual), false)
    return next()
  }, { global: true })
  const output = []
  for await (const chunk of prepared.stream(options)) output.push(chunk)
  assert.equal(observed, 1)
  assert.equal(dispatched, 1)
  assert.deepEqual(output, [{ type: 'finish', reason: { kind: 'stop' } }])
})

test('foreign runtime fails closed when the anchor is missing, invalid, or resolves the wrong peer', async t => {
  if (hostLlm.LlmRuntime === localLlm.LlmRuntime) {
    t.skip('foreign-runtime fixture requires distinct peers')
    return
  }
  const { runtime } = await mountedRuntime(t, hostLlm, HostContext)
  for (const anchor of [null, '', 'relative-entry.js', `${hostAnchor}.missing-identity-fixture`, localAnchor]) {
    assert.equal(await resolveRequestIdentity(runtime, anchor), null, `must reject unavailable/mismatched anchor ${anchor}`)
  }
})

test('request identity never accepts a runtime by method shape alone', async () => {
  const lookalike = { prepareCall() {}, stream() {}, listProviders() { return [] } }
  for (const runtime of [null, undefined, {}, lookalike]) {
    assert.equal(await resolveRequestIdentity(runtime, hostAnchor), null)
    assert.equal(await resolveRequestIdentity(runtime, localAnchor), null)
  }
})
