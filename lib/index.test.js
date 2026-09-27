import test from 'node:test'
import assert from 'node:assert/strict'
import { markAgentLoopRequest, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply, cacheExpiryAt, captureSessionSnapshot, consumeShadowStream, createShadowRequest,
  createWarmScheduler, isCurrentSnapshot, runShadowWarm, statusFor, updateRoute } from './index.js'
import { observations } from './observations.js'
import { policyFor, warmingDecision, nextDecisionAt, decisionDelay, windowEnd, ratesFor, usageCost,
  codexLifetime, createCatalogReader, MINUTE } from './policy.js'

const policy = policyFor('codex-personal', 'gpt-6-astra')
const config = { autoWarmNewChats: false, activeMinutes: 60, idleMinutes: 30 }
const usage = { inputTokens: 1000, cacheReadTokens: 200000, outputTokens: 200 }
const cost = { input: 10, cacheRead: 1, cacheWrite: 0, output: 50 }
const chunks = list => (async function* () { yield* list })()
function fixture() {
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic' }] }]
  const header = { config: { provider: policy.provider, model: policy.model, reasoningEffort: 'high', maxTokens: 1000 }, tools: [{ name: 'lookup', parameters: {} }] }
  const session = { id: 's', header: {}, requestHeader: () => header,
    toolHistory: () => ({ tools: header.tools, updates: [] }), deriveMessages: () => messages,
    surface: { nodes: [1], contentGeneration: 1, replaceGeneration: 0 }, _messages: messages }
  const options = () => markAgentLoopRequest({ ...header.config, sessionId: session.id, messages: [...messages],
    tools: header.tools, toolHistory: session.toolHistory() })
  return { session, header, options }
}

test('pricing uses only current input including cached tokens and full-context tier boundaries', () => {
  const active = warmingDecision({ usage, cost, policy, active: true })
  assert.equal(active.inputTokens, 201000)
  assert.equal(active.reusableTokens, 200000)
  assert.equal(active.probability, 1)
  assert.equal(active.worthwhile, true)
  assert.equal(active.outputReserve, 1024)
  const idle = warmingDecision({ usage, cost, policy, active: false })
  assert.equal(idle.probability, .15)
  assert.equal(idle.worthwhile, false)
  assert.equal(warmingDecision({ usage, cost: null, policy }).reason, 'unknown-pricing')
  assert.equal(warmingDecision({ usage: {inputTokens: 10000,outputTokens: 1}, cost, policy }).reason, 'no-cache-evidence')
  assert.equal(warmingDecision({ usage, cost: {...cost,cacheRead: undefined}, policy }).reason, 'unknown-pricing')
  assert.equal(ratesFor({...cost,tiers:[{inputTokensAbove:200000,input:20,cacheRead:2,output:75}]},201000).input, .00002)
  assert.equal(usageCost({inputTokens:0,cacheReadTokens:300000,outputTokens:0}, {...cost,tiers:[{inputTokensAbove:272000,cacheRead:2}]}), .6)
  const observed = warmingDecision({ usage, cost, policy, active:true, observedWarmOutput: 5000 })
  assert.equal(observed.outputReserve,5000)
  assert.ok(observed.refreshCostUsd > active.refreshCostUsd)
})

test('cheap OpenRouter context is correctly skipped by Pi savings rule', () => {
  const get = createCatalogReader()
  assert.ok(get('codex-personal','gpt-6-astra'))
  const p = policyFor('openrouter','~deepseek/deepseek-v4-flash-latest')
  const result = warmingDecision({usage:{inputTokens:0,cacheReadTokens:100000,outputTokens:1},cost:get(p.provider,p.model),policy:p,active:true})
  assert.equal(result.worthwhile,false)
  assert.equal(result.reason,'insufficient-savings')
  assert.equal(p.cacheTtlMs,null)
  assert.equal(decisionDelay(p),5*MINUTE)
})

test('reviewed Codex families estimate lifetime without inventing future family support', () => {
  for (const model of ['gpt-6-astra','gpt-6-sol','gpt-5.6-sol','gpt-5.6-luna-2026-01-01']) assert.equal(codexLifetime(model),30*MINUTE)
  assert.equal(codexLifetime('gpt-5.3-codex'),5*MINUTE)
  for (const model of ['gpt-7','arbitrary','gpt-6-unreviewed']) assert.equal(codexLifetime(model),null)
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
  assert.equal(shadow.maxTokens,1000,'Codex must not imply a hard one-token cap')
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
    runEndedAt:1000,agentRunning:false,decision:warmingDecision({usage,cost,policy,active:false})}
  const result=statusFor(state,config,true,2000)
  assert.equal(result.reasonCode,'insufficient-savings');assert.equal(result.cacheEstimated,true)
  assert.equal(result.cacheExpiresAt,1000+30*MINUTE)
  assert.equal(result.warmingActive,false)
  updateRoute(state,'other','model');assert.equal(state.lastCacheHitAt,null)
  assert.equal(statusFor(state,config,true).supported,false)
})

/** Full Host lifecycle fixture: real scheduler, projection fold and public Codex seam, no HTTP. */
async function hostFixture(t,{warmUsage=usage,settings=config,storageFails=false,hang=false}={}) {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000})
  const {session,options,header}=fixture()
  const handlers=new Map(),cleanups=[],tables=new Map(),calls=[]
  let projectionState=observations.init(),http
  let running=true
  const owner={options:{name:'dsh-codex-account',id:'codex-account'},fiber:{state:2}}
  const llm={listProviders:()=>[{id:policy.provider}],prepareCall:async c=>({config:c,stream:o=>{
    calls.push(o)
    if(hang) return (async function*(){await new Promise(()=>{})})()
    return chunks([{type:'usage',usage:warmUsage},{type:'finish',reason:{kind:'stop'}}])
  }})}
  owner.fiber.config = {accounts:[{provider:policy.provider,id:'test-account'}],models:[],transport:'sse',cacheRetention:'long'}
  owner.fiber.uid = 1
  const services={llm,configEditor:{entries:()=>[owner]},settings:{describe:()=>[]},
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
  apply(ctx,settings)
  for(let i=0;i<5;i++)await Promise.resolve()
  const event=e=>{projectionState=observations.apply(projectionState,e);handlers.get('session/event')?.(session,e)}
  event({type:'request/header',data:{header},time:Date.now()})
  const dispatch=()=>{handlers.get('llm/stream')(options(),()=>chunks([]))}
  const complete=()=>{
    const message={role:'assistant',source:{provider:policy.provider,model:policy.model},content:[{type:'text',text:'done'}]}
    session._messages.push(message);session.surface.nodes.push(session.surface.nodes.length+1)
    event({type:'assistant/message',surfaceOp:'append',time:Date.now(),data:{message,usage}})
  }
  const idle=()=>{running=false;event({type:'turn/end',time:Date.now(),data:{reason:{kind:'completed'}}});handlers.get('agent/status')({agent:{id:'s'},status:'idle'})}
  const post=async body=>(await http(new Request('http://localhost/api/dsh-cache-warmer',{method:'POST',body:JSON.stringify(body)}))).json()
  const status=async()=>(await http(new Request('http://localhost/api/dsh-cache-warmer?sessionId=s'))).json()
  const tick=async ms=>{t.mock.timers.tick(ms);for(let i=0;i<50;i++)await Promise.resolve()}
  t.after(async()=>{for(const cleanup of cleanups)await cleanup();t.mock.timers.reset()})
  return {calls,tables,dispatch,complete,idle,post,status,tick,event,handlers,session}
}

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
  assert.equal(f.calls[0].messages.at(-1).content[0].text,'Reply only OK. Do not use tools.')
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

test('Host lifecycle: cache miss stops recurrence and remains accounted',async t=>{
  const f=await hostFixture(t,{warmUsage:{inputTokens:201000,cacheReadTokens:0,outputTokens:1}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  await f.tick(27*MINUTE)
  assert.equal(f.calls.length,1)
  assert.equal((await f.status()).reasonCode,'stopped')
  assert.equal((await f.status()).warmUsage.completed,1)
  await f.tick(27*MINUTE);assert.equal(f.calls.length,1)
})

test('Host lifecycle: idle deadline allows exactly one successful renewal',async t=>{
  const f=await hostFixture(t)
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

test('Host lifecycle: cancelled noncooperative I/O cannot overlap a later warm request',async t=>{
  const f=await hostFixture(t,{hang:true,settings:{...config,activeMinutes:1440}})
  f.dispatch();f.complete();await f.post({sessionId:'s',enabled:true})
  await f.tick(27*MINUTE);assert.equal(f.calls.length,1)
  f.dispatch();f.complete()
  assert.equal(f.calls[0].signal.aborted,true)
  await f.tick(27*MINUTE)
  assert.equal(f.calls.length,1,'single-flight remains locked until actual transport cleanup')
})
