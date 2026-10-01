import test from 'node:test'
import assert from 'node:assert/strict'
import { markAgentLoopRequest, isAgentLoopRequest, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Config, apply, cacheExpiryAt, captureSessionSnapshot, consumeShadowStream, createShadowRequest,
  createWarmScheduler, isCurrentSnapshot, runShadowWarm, statusFor, updateRoute, applyWithTransport } from './index.js'
import { observations } from './observations.js'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createRequire, findPackageJSON } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const piManifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'))
const { openaiCodexProvider } = createRequire(piManifest)(fileURLToPath(new URL('./dist/providers/openai-codex.js', pathToFileURL(piManifest))))
import { policyFor, warmingDecision, nextDecisionAt, decisionDelay, windowEnd, MINUTE } from './policy.js'

const routePolicy = { provider: 'openrouter', model: 'openai/gpt-4.1', enabled: true, cacheMinutes: 30 }
const config = { autoWarmNewChats: false, activeMinutes: 60, idleMinutes: 30,
  modelPolicies: [routePolicy] }
const policy = policyFor(routePolicy.provider, routePolicy.model, config)
const testEstimate = price => buckets => {
  const total = Object.values(buckets).reduce((sum, value) => sum + value, 0)
  const input = (buckets.input ?? 0) + (buckets.cacheRead ?? 0) + (buckets.cacheWrite ?? 0)
  const rate = [...(price?.tiers ?? [])].filter(tier => input > tier.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0]
  if (total < 0 || !price) return null
  const selected = { ...price, ...rate }
  return Object.entries(buckets).reduce((sum, [key, amount]) => sum + amount * selected[key] / 1e6, 0)
}
const usage = { inputTokens: 1000, cacheReadTokens: 200000, outputTokens: 200 }
const cost = { input: 10, cacheRead: 1, cacheWrite: 0, output: 50 }
const chunks = list => (async function* () { yield* list })()
function fixture(route = policy) {
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic' }] }]
  const header = { config: { provider: route.provider, model: route.model, reasoningEffort: 'high', maxTokens: 1000 }, tools: [{ name: 'lookup', parameters: {} }] }
  const session = { id: 's', header: {}, requestHeader: () => header,
    toolHistory: () => ({ tools: header.tools, updates: [] }), deriveMessages: () => messages,
    surface: { nodes: [1], contentGeneration: 1, replaceGeneration: 0 }, _messages: messages }
  const options = () => markAgentLoopRequest({ ...header.config, sessionId: session.id, messages: [...messages],
    tools: header.tools, toolHistory: session.toolHistory() })
  return { session, header, options }
}

test('pricing uses only current input including cached tokens and full-context tier boundaries', () => {
  const active = warmingDecision({ usage, estimate: testEstimate(cost), policy, active: true })
  assert.equal(active.inputTokens, 201000)
  assert.equal(active.reusableTokens, 200000)
  assert.equal(active.probability, 1)
  assert.equal(active.worthwhile, true)
  assert.equal(active.outputReserve, 8)
  const idle = warmingDecision({ usage, estimate: testEstimate(cost), policy, active: false })
  assert.equal(idle.probability, .15)
  assert.ok(idle.expectedSavingsUsd < active.expectedSavingsUsd)
  assert.equal(warmingDecision({ usage, estimate: null, policy }).reason, 'unknown-pricing')
  assert.equal(warmingDecision({ usage: {inputTokens: 10000,outputTokens: 1}, estimate: testEstimate(cost), policy }).reason, 'no-cache-evidence')
  assert.equal(warmingDecision({ usage, estimate: () => NaN, policy }).reason, 'unknown-pricing')
  assert.equal(testEstimate({...cost,tiers:[{inputTokensAbove:200000,input:20,cacheRead:2,output:75}]})({input:201000}), 4.02)
  assert.equal(testEstimate({...cost,tiers:[{inputTokensAbove:272000,cacheRead:2}]})({cacheRead:300000}), .6)
  const observed = warmingDecision({ usage, estimate: testEstimate(cost), policy, active:true, observedWarmOutput: 5000 })
  assert.equal(observed.outputReserve,5000)
  assert.ok(observed.refreshCostUsd > active.refreshCostUsd)
})

test('cheap OpenRouter context is correctly skipped by Pi savings rule', () => {
  const p = policyFor('openrouter','~deepseek/deepseek-v4-flash-latest')
  const result = warmingDecision({usage:{inputTokens:0,cacheReadTokens:100000,outputTokens:1},
    estimate:testEstimate({input:.3,output:.4,cacheRead:.03,cacheWrite:.3}),policy:p,active:true})
  assert.equal(result.worthwhile,false)
  assert.equal(result.reason,'insufficient-savings')
  assert.equal(p.cacheTtlMs,null)
  assert.equal(decisionDelay(p),null)
})

test('unsupported account and official routes remain observation-only even with custom policies', () => {
  for (const provider of ['openai-codex', 'deepseek-official', 'codex-business']) {
    const observed = policyFor(provider, 'gpt-6-sol', { modelPolicies: [
      { provider, model: 'gpt-6-sol', enabled: true, cacheMinutes: 30 }] })
    assert.equal(observed.transportSupported, false)
    assert.equal(observed.warmingAllowed, false)
    assert.equal(nextDecisionAt({lastRequestAt:1000, agentRunning:true}, true, config, observed, 1000), null)
  }
})

test('30-minute idle horizon permits one 27-minute decision but not a second', () => {
  const state = {lastRequestAt:1000,lastCacheHitAt:1000,agentRunning:false,warmFailureCount:0}
  assert.equal(decisionDelay(policy),27*MINUTE)
  assert.equal(nextDecisionAt(state,true,config,policy,1000),1000+27*MINUTE)
  state.lastWarmAt=1000+27*MINUTE; state.lastCacheHitAt=state.lastWarmAt
  assert.equal(nextDecisionAt(state,true,config,policy,state.lastWarmAt),null)
  assert.equal(windowEnd(state,config),1000+30*MINUTE)
  assert.equal(cacheExpiryAt({...state,cacheTtlMs:policy.cacheTtlMs}),1000+57*MINUTE)
  assert.equal(nextDecisionAt({...state,agentRunning:true},true,config,policy,state.lastWarmAt),1000+54*MINUTE)
  assert.equal(nextDecisionAt(state,false,config,policy,1000),null)
  assert.equal(nextDecisionAt(state,true,{...config,idleMinutes:0},policy,1000),null)
  assert.equal(nextDecisionAt({...state,warmFailureCount:1},true,config,policy,1000),null)
  assert.equal(nextDecisionAt({...state,lastWarmAt:null,lastCacheHitAt:1000},true,config,policy,1000+31*MINUTE),null)
  assert.equal(decisionDelay({...policy,cacheTtlMs:60_000}),50_000)
})

test('snapshot tolerates tool progress but rejects human input, route/compaction/history changes', () => {
  const {session,options,header}=fixture()
  const snapshot=captureSessionSnapshot(session,options())
  session._messages.push({role:'assistant',source:{provider:policy.provider,model:policy.model},content:[]})
  session._messages.push({role:'tool',content:[]});session.surface.nodes.push(2,3)
  assert.equal(isCurrentSnapshot(session,snapshot),true)
  header.config.model='other';assert.equal(isCurrentSnapshot(session,snapshot),false);header.config.model=policy.model
  session._messages.push({role:'user',content:[]});assert.equal(isCurrentSnapshot(session,snapshot),false);session._messages.pop()
  session.surface.replaceGeneration++;assert.equal(isCurrentSnapshot(session,snapshot),false)
})

test('shadow has no loop marker, preserves all original controls and never executes tools',async()=>{
  const {session,options}=fixture();const original=options();const snapshot=captureSessionSnapshot(session,original)
  const signal=new AbortController().signal
  const shadow=createShadowRequest(session,snapshot,policy,signal)
  assert.equal(isAgentLoopRequest(shadow),false)
  assert.equal(shadow.maxTokens,8,'OpenRouter refresh retains the bounded output cap')
  assert.deepEqual(shadow.tools,original.tools)
  const before=JSON.stringify(session._messages)
  const result=await runShadowWarm({session,snapshot,policy,llm:{stream:()=>chunks([
    {type:'tool-call-delta',id:'ignored',name:'lookup',argumentsDelta:'{}'},
    {type:'usage',usage}, {type:'finish',reason:{kind:'stop'}}])}})
  assert.deepEqual(result.usage,usage)
  assert.equal(JSON.stringify(session._messages),before)
})

test('stream consumer cancels stalled I/O and refuses already aborted work',async()=>{
  const controller=new AbortController()
  await assert.rejects(consumeShadowStream((async function*(){await new Promise(()=>{})})(),{controller,timeoutMs:5}),/timeout/)
  assert.equal(controller.signal.aborted,true)
  const {session,options}=fixture();let calls=0
  const result=await runShadowWarm({session,snapshot:captureSessionSnapshot(session,options()),policy,
    signal:AbortSignal.abort(),llm:{stream:()=>{calls++;return chunks([])}}})
  assert.equal(result,null);assert.equal(calls,0)
})

test('scheduler replaces timers and tears down',async()=>{
  let id=0;const timers=new Map(),calls=[]
  const scheduler=createWarmScheduler({now:()=>100,setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id},clearTimer:key=>timers.delete(key),run:(key,value)=>calls.push([key,value])})
  scheduler.schedule('s',400,'old');scheduler.schedule('s',300,'new')
  assert.equal(scheduler.size(),1);assert.equal([...timers.values()][0].ms,200)
  const timer=[...timers.values()][0];timers.clear();timer.fn();await Promise.resolve()
  assert.deepEqual(calls,[['s','new']]);scheduler.schedule('s',400,'end');scheduler.dispose();assert.equal(timers.size,0)
})

test('projection keeps cached evidence distinct from successful uncached requests and invalidates replaced context',()=>{
  let state=observations.init()
  state=observations.apply(state,{type:'request/header',data:{header:{config:{provider:policy.provider,model:policy.model}}}})
  const event={type:'assistant/message',time:1000,data:{message:{source:{provider:policy.provider,model:policy.model}},usage}}
  state=observations.apply(state,event)
  assert.equal(state.lastCacheHitAt,1000)
  state=observations.apply(state,{...event,time:2000,data:{...event.data,usage:{inputTokens:201000,outputTokens:1}}})
  assert.equal(state.lastCacheHitAt,null)
  state=observations.apply(state,event)
  state=observations.apply(state,{type:'user/message',surfaceOp:{op:'replace'},data:{}})
  assert.equal(state.lastCacheHitAt,null)
})

test('status is explicit about estimate, economics and unsupported routes',()=>{
  const state={sessionId:'s',provider:policy.provider,model:policy.model,transportAvailable:true,storageAvailable:true,
    cacheTtlMs:policy.cacheTtlMs,lastCacheHitAt:1000,lastRequestAt:1000,lastRequestFinished:true,lastRequestSnapshot:{},
    runEndedAt:1000,agentRunning:false,decision:warmingDecision({usage,estimate:testEstimate(cost),policy,active:false})}
  const result=statusFor(state,config,true,2000)
  assert.equal(result.reasonCode,'decision-pending');assert.equal(result.cacheEstimated,true)
  assert.equal(result.cacheExpiresAt,1000+30*MINUTE)
  assert.equal(result.warmingActive,false)
  updateRoute(state,'other','model');assert.equal(state.lastCacheHitAt,null)
  assert.equal(statusFor(state,config,true).supported,false)
})

/** Full Host lifecycle fixture: real scheduler and projection fold; offline bounded transport. */
async function hostFixture(t,{warmUsage=usage,requestUsage=usage,settings=config,storageFails=false,hang=false,route=policy,retention='long',editWait=null,native=false}={}) {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000})
  const {session,options,header}=fixture(route)
  const handlers=new Map(),cleanups=[],tables=new Map(),calls=[]
  let projectionState=observations.init(),http
  let running=true
  const owner={options:{name:'@deepseek-ai/dsh-llm-pi-ai',id:'test-provider'},fiber:{state:2}}
  const pluginEntry={options:{name:'dsh-cache-warmer',id:'dsh-cache-warmer'},fiber:{state:2}}
  const saved=[]
  const llm=Object.assign(Object.create(LlmRuntime.prototype), {listProviders:()=>[{id:route.provider,name:route.provider}],listModels:async()=>[{provider:route.provider,id:route.model,name:route.model}],prepareCall:async c=>({config:c,stream:o=>{
    calls.push(o)
    if(hang) return (async function*(){await new Promise(()=>{})})()
    return chunks([{type:'usage',usage:warmUsage},{type:'finish',reason:{kind:'stop'}}])
  }})})
  if (native) {
    const profile = { provider: route.provider, piProvider: openaiCodexProvider(), cacheRetention: retention,
      configuredMaxTokens: new Map(), modelErrors: new Map() }
    const adapter = new PiAiAdapter({ profiles: () => new Map([[route.provider, profile]]), resolveApiKey: async () => undefined,
      auth: { credentials: { read: async () => undefined }, authContext: {} } })
    // Keep snapshot identities stable exactly like the real provider plugin.
    const profiles = new Map([[route.provider, profile]])
    adapter.config.profiles = () => profiles
    llm.adapters = new Map([[route.provider, { adapter, provider: { id: route.provider } }]])
  }
  owner.fiber.config = {accounts:[{provider:route.provider,id:'test-account'}],models:[],transport:'sse',cacheRetention:retention}
  owner.fiber.uid = 1
  const services={llm,configEditor:{entries:()=>[owner,pluginEntry],edit:async(_entry,change)=>{saved.push(structuredClone(change()));if(editWait)await editWait}},
    credentials:{},settings:{describe:()=>route.provider==='openrouter'?[{ns:'test-provider',revision:1,value:{providers:{openrouter:{apiKeyEnv:'OFFLINE_KEY',cacheRetention:retention}}}}]:[]},
    agents:{get:()=>({status:running?'running':'idle'})}}
  const ctx={...services,get:key=>services[key],on:(name,fn)=>{handlers.set(name,fn)},effect:fn=>cleanups.push(fn()),
    sessions:{get:id=>id===session.id?session:undefined,list:()=>[session]},
    sessionProjections:{register:()=>{},stateOf:()=>projectionState},
    connection:{fetch:{register:async r=>{http=r.fetch;return ()=>{}}}},
    storageDomain:{open:async spec=>({table:name=>{
      const key=spec.name+'/'+name
      if(!tables.has(key)) tables.set(key,new Map())
      const map=tables.get(key)
      return {get:k=>map.get(k),put:async(k,v)=>{if(storageFails&&name==='summaries')throw new Error('offline write failure');map.set(k,v)}}
    },close:async()=>{}})}}
  await applyWithTransport(ctx,settings,async()=>llm.prepareCall({ provider: route.provider, model: route.model }))
  for(let i=0;i<5;i++)await Promise.resolve()
  const event=e=>{projectionState=observations.apply(projectionState,e);handlers.get('session/event')?.(session,e)}
  event({type:'request/header',data:{header},time:Date.now()})
  const dispatch=()=>{handlers.get('llm/stream')(options(),()=>chunks([]))}
  const complete=()=>{
    const message={role:'assistant',source:{provider:route.provider,model:route.model},content:[{type:'text',text:'done'}]}
    session._messages.push(message);session.surface.nodes.push(session.surface.nodes.length+1)
    event({type:'assistant/message',surfaceOp:'append',time:Date.now(),data:{message,usage:requestUsage}})
  }
  const idle=()=>{running=false;event({type:'turn/end',time:Date.now(),data:{reason:{kind:'completed'}}});handlers.get('agent/status')({agent:{id:'s'},status:'idle'})}
  const post=async body=>(await http(new Request('http://localhost/api/dsh-cache-warmer',{method:'POST',body:JSON.stringify(body)}))).json()
  const status=async()=>(await http(new Request('http://localhost/api/dsh-cache-warmer?sessionId=s'))).json()
  const tick=async ms=>{t.mock.timers.tick(ms);for(let i=0;i<50;i++)await Promise.resolve()}
  t.after(async()=>{for(const cleanup of cleanups)await cleanup();t.mock.timers.reset()})
  const getSettings=async()=>(await http(new Request('http://localhost/api/dsh-cache-warmer?scope=settings'))).json()
  const getModels=async()=>(await http(new Request('http://localhost/api/dsh-cache-warmer?scope=models'))).json()
  return {getModels,calls,tables,dispatch,complete,idle,post,status,tick,event,handlers,session,saved,getSettings,owner,
    services}
}

test('Host lifecycle: independent pricing works without modelPricing service', async t => {
  const f = await hostFixture(t)
  assert.equal(f.services.modelPricing, undefined)
  f.dispatch(); f.complete(); await f.post({ sessionId: 's', enabled: true })
  assert.equal((await f.status()).warmingState, 'scheduled')
})

test('Host lifecycle: verified Codex native route schedules only after separate best-effort consent', async t => {
  const route = { provider: 'openai-codex', model: 'gpt-6.1-sol' }
  const settings = { ...config, modelPolicies: [{ ...route, enabled: true, cacheMinutes: 30 }] }
  const f = await hostFixture(t, { native: true, route, settings })
  const directory = await f.getModels()
  const advertised = directory.providers[0].models[0]
  assert.equal(advertised.transportSupported, true)
  assert.equal(advertised.outputBound, 'client')
  f.dispatch(); f.complete(); await f.post({ sessionId: 's', enabled: true })
  assert.equal((await f.status()).reasonCode, 'client-bound-opt-in-required')
  assert.equal((await f.status()).nextRefreshAt, null)
  for (const invalid of ['true', 1, null]) {
    assert.equal((await f.post({ scope: 'settings', ...settings, allowClientBoundWarming: invalid })).error, 'invalid-settings')
  }
  await f.post({ scope: 'settings', ...settings, allowClientBoundWarming: true })
  await f.post({ scope: 'settings', ...settings })
  assert.equal((await f.getSettings()).allowClientBoundWarming, true, 'older clients preserve separate consent')
  f.dispatch(); f.complete()
  const status = await f.status()
  assert.equal(status.transportSupported, true)
  assert.equal(status.outputBound, 'client')
  assert.match(status.warmingWarning, /not spending or quota caps/)
  assert.equal(status.warmingState, 'scheduled')
  await f.tick(27 * MINUTE)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].provider, route.provider)
  assert.equal(f.calls[0].maxTokens, 256)
  assert.equal((await f.status()).warmUsage.completed, 1)
})

for (const event of ['credentials/reference-updated', 'credentials/record-updated']) test(`credential authority changes invalidate native capture and cache evidence (${event})`, async t => {
  const route = { provider: 'openai-codex', model: 'gpt-6.1-sol' }
  const settings = { ...config, allowClientBoundWarming: true, modelPolicies: [{ ...route, enabled: true, cacheMinutes: 30 }] }
  const f = await hostFixture(t, { native: true, route, settings })
  f.dispatch(); f.complete(); await f.post({ sessionId: 's', enabled: true })
  assert.equal((await f.status()).warmingState, 'scheduled')
  f.handlers.get(event)()
  const status = await f.status()
  assert.equal(status.requestCaptured, false)
  assert.equal(status.lastCacheHitAt, null)
  assert.equal(status.cacheExpiresAt, null)
  assert.equal(status.nextRefreshAt, null)
  await f.tick(27 * MINUTE)
  assert.equal(f.calls.length, 0)
})

test('Host lifecycle: non-pi-ai account routes are observable but never send', async t => {
  const route = policyFor('openai-codex', 'gpt-6-sol', { modelPolicies: [
    { provider: 'openai-codex', model: 'gpt-6-sol', enabled: true, cacheMinutes: 30 }] })
  const f = await hostFixture(t, { route, settings: { ...config, modelPolicies: [
    { provider: route.provider, model: route.model, enabled: true, cacheMinutes: 30 }] } })
  f.dispatch(); f.complete(); await f.post({ sessionId: 's', enabled: true })
  assert.equal((await f.status()).supported, false)
  await f.tick(54 * MINUTE)
  assert.equal(f.calls.length, 0)
})

test('Host lifecycle: opt-in, due refresh, persistent accounting, no transcript mutation, foreground invalidation',async t=>{
  const f=await hostFixture(t)
  f.dispatch();f.complete()
  const off=await f.status();assert.equal(off.enabled,false)
  await f.post({sessionId:'s',enabled:true})
  const before=JSON.stringify(f.session._messages)
  assert.equal((await f.status()).nextRefreshAt,1000+27*MINUTE)
  await f.tick(27*MINUTE)
  assert.equal(f.calls.length,1)
  assert.equal(JSON.stringify(f.session._messages),before)
  assert.equal(f.calls[0].messages.at(-1).content[0].text,'synthetic')
  const after=await f.status()
  assert.equal(after.lastWarmCacheHitTokens,200000)
  assert.equal(after.warmUsage.attempts,1)
  assert.equal(after.warmUsage.completed,1)
  assert.ok(after.warmUsage.usd>0)
  assert.equal(after.nextRefreshAt,1000+54*MINUTE)
  f.event({type:'user/message',surfaceOp:'append',time:Date.now(),data:{}})
  await f.tick(27*MINUTE)
  assert.equal(f.calls.length,1)
})

test('Host lifecycle: captured in-flight request is distinct from missing context, then schedules or skips on completion',async t=>{
  // More uncached input makes idle negative at the actual catalog's write rate.
  const f=await hostFixture(t,{requestUsage:{...usage,inputTokens:10000}})
  await f.post({sessionId:'s',enabled:true})
  assert.equal((await f.status()).reasonCode,'no-context')
  f.dispatch()
  const inFlight=await f.status()
  assert.equal(inFlight.reasonCode,'request-in-flight')
  assert.equal(inFlight.requestCaptured,true)
  assert.equal(inFlight.requestCompleted,false)
  assert.equal(inFlight.nextRefreshAt,null)
  f.complete()
  const completed=await f.status()
  assert.equal(completed.reasonCode,'ready')
  assert.equal(completed.requestCompleted,true)
  assert.equal(completed.lastRequestCompletedAt,1000)
  assert.equal(completed.nextRefreshAt,1000+27*MINUTE)
  f.idle()
  const idle=await f.status()
  assert.equal(idle.reasonCode,'insufficient-savings')
  assert.equal(idle.requestCompleted,true)
  assert.equal(idle.nextRefreshAt,null)
})

test('Host lifecycle: cache miss stops recurrence and remains accounted',async t=>{
  const f=await hostFixture(t,{warmUsage:{inputTokens:201000,cacheReadTokens:0,outputTokens:1}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  await f.tick(27*MINUTE)
  assert.equal(f.calls.length,1)
  assert.equal((await f.status()).reasonCode,'stopped')
  assert.equal((await f.status()).warmUsage.completed,1)
  await f.tick(27*MINUTE);assert.equal(f.calls.length,1)
})

test('partial refresh hits reduce future economic credit instead of reusing the larger real hit', async t => {
  const f = await hostFixture(t, { warmUsage: { inputTokens: 200990, cacheReadTokens: 10, outputTokens: 2 } })
  f.dispatch(); f.complete(); await f.post({ sessionId: 's', enabled: true })
  await f.tick(27 * MINUTE)
  const status = await f.status()
  assert.equal(f.calls.length, 1)
  assert.equal(status.lastWarmCacheHitTokens, 10)
  assert.equal(status.decision.reusableTokens, 10)
  assert.equal(status.reasonCode, 'insufficient-savings')
  assert.equal(status.nextRefreshAt, null)
  await f.tick(27 * MINUTE)
  assert.equal(f.calls.length, 1)
})

test('Host lifecycle: idle deadline allows exactly one successful renewal',async t=>{
  const f=await hostFixture(t,{settings:{...config,idleContinuationPercent:100}})
  f.dispatch();f.complete();f.idle();await f.post({sessionId:'s',enabled:true})
  assert.equal((await f.status()).windowEndsAt,1000+30*MINUTE)
  await f.tick(27*MINUTE);assert.equal(f.calls.length,1)
  assert.equal((await f.status()).nextRefreshAt,null)
  assert.equal((await f.status()).cacheExpiresAt,1000+57*MINUTE)
  await f.tick(27*MINUTE);assert.equal(f.calls.length,1)
})

test('Host lifecycle: time window replaces arbitrary three-attempt cap',async t=>{
  const f=await hostFixture(t,{settings:{...config,activeMinutes:1440}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  for(let i=0;i<4;i++)await f.tick(27*MINUTE)
  assert.equal(f.calls.length,4)
  assert.equal((await f.status()).warmUsage.attempts,4)
})

test('Host lifecycle: foreground input cancels pending warm timer',async t=>{
  const f=await hostFixture(t)
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  f.event({type:'user/message',surfaceOp:'append',time:Date.now(),data:{}})
  await f.tick(27*MINUTE)
  assert.equal(f.calls.length,0)
  assert.equal((await f.status()).reasonCode,'no-context')
})

test('Host lifecycle: persistence failure is latched across polling, toggles and real requests',async t=>{
  const f=await hostFixture(t,{storageFails:true})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  await f.tick(27*MINUTE);assert.equal(f.calls.length,1)
  assert.equal((await f.status()).reasonCode,'no-storage')
  await f.post({sessionId:'s',enabled:false});await f.post({sessionId:'s',enabled:true})
  f.dispatch();f.complete();await f.tick(27*MINUTE)
  assert.equal(f.calls.length,1)
  assert.equal((await f.status()).reasonCode,'no-storage')
})

test('model policy settings round-trip, validate strictly, cancel timers and preserve rules for older clients',async t=>{
  const f=await hostFixture(t)
  const initial=await f.getSettings()
  assert.equal(initial.useCodexDefaults,true);assert.deepEqual(initial.modelPolicies,[routePolicy])
  assert.equal(initial.defaultModelPolicies,undefined)
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  assert.ok((await f.status()).nextRefreshAt)
  const row={provider:policy.provider,model:policy.model,enabled:false,cacheMinutes:7}
  const next=await f.post({scope:'settings',...config,useCodexDefaults:false,modelPolicies:[row]})
  assert.deepEqual(next.modelPolicies,[row]);assert.equal(next.useCodexDefaults,false)
  assert.equal(f.saved.length,1);assert.equal(f.saved[0].defaultModelPolicies,undefined)
  assert.equal((await f.status()).reasonCode,'policy-disabled')
  await f.tick(27*MINUTE);assert.equal(f.calls.length,0)
  const {modelPolicies: _previousPolicies, ...legacyConfig}=config
  const oldClient=await f.post({scope:'settings',...legacyConfig})
  assert.deepEqual(oldClient.modelPolicies,[row]);assert.equal(oldClient.useCodexDefaults,false)
  const invalid=await f.post({scope:'settings',...config,modelPolicies:[row,row]})
  assert.equal(invalid.error,'invalid-model-policies');assert.equal(f.saved.length,2)
  const reset=await f.post({scope:'settings',...config,useCodexDefaults:true,modelPolicies:[]})
  assert.deepEqual(reset.modelPolicies,[])
  assert.equal((await f.status()).reasonCode,'unknown-lifetime','TTL remains unknown without a custom policy')
  f.dispatch();f.complete();assert.equal((await f.status()).reasonCode,'unknown-lifetime')
})

test('cost settings round-trip, preserve old clients, validate without coercion, and cancel existing decisions', async t => {
  const f = await hostFixture(t)
  assert.equal((await f.getSettings()).minExpectedBenefitUsd, .05)
  assert.equal((await f.getSettings()).idleContinuationPercent, 15)
  f.dispatch(); f.complete(); await f.post({ sessionId: 's', enabled: true })
  assert.equal((await f.status()).warmingState, 'scheduled')
  const saved = await f.post({ scope: 'settings', ...config, minExpectedBenefitUsd: 1000, idleContinuationPercent: 42 })
  assert.equal(saved.minExpectedBenefitUsd, 1000)
  assert.equal(saved.idleContinuationPercent, 42)
  assert.equal(f.saved[0].minExpectedBenefitUsd, 1000)
  assert.equal((await f.status()).nextRefreshAt, null)
  assert.equal((await f.status()).requestCaptured, false)
  const older = await f.post({ scope: 'settings', ...config })
  assert.equal(older.minExpectedBenefitUsd, 1000)
  assert.equal(older.idleContinuationPercent, 42)
  for (const patch of [
    { minExpectedBenefitUsd: null }, { minExpectedBenefitUsd: '' }, { minExpectedBenefitUsd: '0.05' },
    { minExpectedBenefitUsd: -1 }, { minExpectedBenefitUsd: 1001 }, { minExpectedBenefitUsd: true },
    { idleContinuationPercent: null }, { idleContinuationPercent: '' }, { idleContinuationPercent: '15' },
    { idleContinuationPercent: -1 }, { idleContinuationPercent: 101 }, { idleContinuationPercent: 15.5 },
  ]) assert.equal((await f.post({ scope: 'settings', ...config, ...patch })).error, 'invalid-settings')
  assert.equal(f.saved.length, 2, 'invalid input never persists')
  f.dispatch(); f.complete()
  assert.equal((await f.status()).decision.thresholdUsd, 1000)
  assert.equal((await f.status()).warmingState, 'skipped')
  await f.tick(27 * MINUTE); assert.equal(f.calls.length, 0)
})

test('idle probability controls actual scheduling without changing the active probability', async t => {
  const f = await hostFixture(t, { settings: { ...config, idleContinuationPercent: 100 }, requestUsage: { ...usage, inputTokens: 10000 } })
  f.dispatch(); f.complete(); await f.post({ sessionId: 's', enabled: true }); f.idle()
  assert.equal((await f.status()).decision.probability, 1)
  assert.equal((await f.status()).warmingState, 'scheduled')
  await f.post({ scope: 'settings', ...config, idleContinuationPercent: 0, minExpectedBenefitUsd: 0 })
  f.dispatch(); f.complete()
  assert.equal((await f.status()).warmingState, 'disabled')
  assert.equal((await f.status()).reasonCode, 'idle-probability-zero')
  assert.equal((await f.status()).nextRefreshAt, null)
  await f.tick(27 * MINUTE); assert.equal(f.calls.length, 0)
})

test('legacy config normalizes through schema and persists one conservative lifetime',async t=>{
  const legacy={provider:policy.provider,model:policy.model,enabled:false,shortMinutes:10,longMinutes:30}
  const settings=Config({...config,modelPolicies:[legacy]})
  const f=await hostFixture(t,{settings})
  const canonical={provider:policy.provider,model:policy.model,enabled:false,cacheMinutes:10}
  assert.deepEqual((await f.getSettings()).modelPolicies,[canonical])
  const saved=await f.post({scope:'settings',...config,modelPolicies:[legacy]})
  assert.deepEqual(saved.modelPolicies,[canonical]);assert.deepEqual(f.saved[0].modelPolicies,[canonical])
  const single=Config({...config,modelPolicies:[{...canonical,cacheMinutes:null}]})
  assert.deepEqual(single.modelPolicies,[{...canonical,cacheMinutes:null}])
})

test('settings save latch prevents capture and warming during a delayed policy edit',async t=>{
  let finishEdit
  const editWait=new Promise(resolve=>{finishEdit=resolve})
  const row={provider:policy.provider,model:policy.model,enabled:true,cacheMinutes:1}
  const f=await hostFixture(t,{editWait,settings:{...config,modelPolicies:[row]}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  const pending=f.post({scope:'settings',...config,modelPolicies:[{...row,enabled:false}]})
  await f.tick(0);assert.equal(f.saved.length,1)
  f.dispatch();f.complete()
  await f.tick(54_000);assert.equal(f.calls.length,0)
  finishEdit();await pending
  assert.equal((await f.status()).reasonCode,'policy-disabled')
  assert.equal((await f.status()).requestCaptured,false)
  assert.equal((await f.status()).nextRefreshAt,null)
})

test('retention none reports disabled rather than an unknown lifetime',async t=>{
  const f=await hostFixture(t,{retention:'none'})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  assert.equal((await f.status()).reasonCode,'retention-disabled')
  assert.equal((await f.status()).cacheTtlMs,null)
})

test('custom OpenRouter policy schedules using the single configured lifetime',async t=>{
  const modelPolicies=[{provider:policy.provider,model:policy.model,enabled:true,cacheMinutes:10}]
  const f=await hostFixture(t,{settings:{...config,modelPolicies}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  const status=await f.status()
  assert.equal(status.ruleSource,'custom');assert.equal(status.retention,'long')
  assert.equal(status.cacheTtlMs,10*MINUTE);assert.equal(status.nextRefreshAt,1000+9*MINUTE)
  await f.tick(9*MINUTE);assert.equal(f.calls.length,1)
})

test('OpenRouter DeepSeek stays observation-only without lifetime even with cache hits and opt-in',async t=>{
  const route={provider:'openrouter',model:'~deepseek/deepseek-v4-flash-latest'}
  const f=await hostFixture(t,{route,retention:'short'})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  const status=await f.status()
  assert.equal(status.requestCompleted,true);assert.equal(status.supported,false)
  assert.equal(status.reasonCode,'unknown-lifetime');assert.equal(status.cacheTtlMs,null)
  assert.equal(status.nextRefreshAt,null);await f.tick(6*MINUTE);assert.equal(f.calls.length,0)
  const rules=[{...route,enabled:true,cacheMinutes:5}]
  await f.post({scope:'settings',...config,modelPolicies:rules})
  f.dispatch();f.complete()
  const configured=await f.status()
  assert.equal(configured.supported,true);assert.equal(configured.retention,'short')
  assert.equal(configured.cacheTtlMs,5*MINUTE)
  assert.equal(configured.reasonCode,'insufficient-savings','TTL does not bypass economics')
  assert.equal(configured.nextRefreshAt,null)
})

test('blank lifetime and disabled legacy defaults keep real requests observation-only',async t=>{
  const modelPolicies=[{provider:policy.provider,model:policy.model,enabled:true,cacheMinutes:null}]
  const f=await hostFixture(t,{retention:'short',settings:{...config,modelPolicies}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  assert.equal((await f.status()).reasonCode,'unknown-lifetime')
  assert.equal((await f.status()).nextRefreshAt,null)
  await f.post({scope:'settings',...config,useCodexDefaults:false,modelPolicies:[]})
  f.dispatch();f.complete()
  assert.equal((await f.status()).cacheTtlMs,null)
  await f.tick(27*MINUTE);assert.equal(f.calls.length,0)
})

test('OpenRouter retention none ignores configured lifetimes and never schedules',async t=>{
  const route={provider:'openrouter',model:'~deepseek/deepseek-v4-flash-latest'}
  const f=await hostFixture(t,{route,retention:'none',settings:{...config,modelPolicies:[{...route,enabled:true,cacheMinutes:5}]}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  assert.equal((await f.status()).reasonCode,'retention-disabled')
  assert.equal((await f.status()).cacheTtlMs,null)
  assert.equal((await f.status()).nextRefreshAt,null)
})

test('Codex observation countdown retains configured lifetime while warming stays unavailable',async t=>{
  const route={provider:'openai-codex',model:'gpt-6.1-sol'}
  const f=await hostFixture(t,{route,settings:{...config,modelPolicies:[{...route,enabled:true,cacheMinutes:30}]}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  const status=await f.status()
  assert.equal(status.retention,'unknown')
  assert.equal(status.cacheTtlMs,30*MINUTE)
  assert.equal(status.cacheExpiresAt,status.lastCacheHitAt+30*MINUTE)
  assert.equal(status.warmingState,'unavailable')
  assert.equal(status.reasonCode,'unsupported')
  assert.equal(status.supported,false)
  assert.equal(status.transportSupported,false)
  assert.equal(status.nextRefreshAt,null)
  await f.tick(27*MINUTE);assert.equal(f.calls.length,0)
})

test('unsupported OpenRouter model cannot acquire a warming transport via configuration',async t=>{
  const route={provider:'openrouter',model:'anthropic/claude-test'}
  const f=await hostFixture(t,{route,retention:'short',settings:{...config,modelPolicies:[{...route,enabled:true,cacheMinutes:5}]}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  const status=await f.status()
  assert.equal(status.reasonCode,'unsupported');assert.equal(status.supported,false)
  assert.equal(status.cacheTtlMs,5*MINUTE);assert.equal(status.nextRefreshAt,null)
})

test('Host lifecycle: cancelled noncooperative I/O cannot overlap a later warm request',async t=>{
  const f=await hostFixture(t,{hang:true,settings:{...config,activeMinutes:1440}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  await f.tick(27*MINUTE);assert.equal(f.calls.length,1)
  f.dispatch();f.complete()
  assert.equal(f.calls[0].signal.aborted,true)
  await f.tick(27*MINUTE)
  assert.equal(f.calls.length,1,'single-flight remains locked until actual transport cleanup')
})


test('model directory endpoint exposes advertised models separately from saved settings', async t => {
  const f = await hostFixture(t)
  const directory = await f.getModels()
  assert.equal(directory.providers.length, 1)
  assert.equal(directory.providers[0].id, policy.provider)
  assert.deepEqual(directory.providers[0].models, [{ id: policy.model, name: policy.model,
    defaultCacheMinutes: null, transportSupported: true, reasonCode: null }])
  assert.equal((await f.getSettings()).providers, undefined)
  assert.equal(f.saved.length, 0)
  assert.equal(f.calls.length, 0, 'discovery must not dispatch inference')
})
