import assert from 'node:assert/strict'
import test from 'node:test'
import { SlimSourceCoordinator } from './slim-source-coordinator'

test('Slim coordinator indexes per Profile first, captures only authorized Source and stops cleanly',async()=>{
  const operations:string[]=[]
  const runtime={
    async resolveHost(){return {id:'host-1'}},
    async resolveInstallation(){return {id:'install'}},
    async resolveProfile(){return {id:'profile-a'}},
    async facets(){return {
      installedProducts:[{productId:'pi',installationIds:['install']}],
      projects:[],projectsTruncated:false,
    }},
    async profiles(){return [
      {id:'profile-a',installationId:'install'},
      {id:'profile-b',installationId:'install'},
    ]},
    async reindexInstallation(input:{runtimeProfileId?:string}){
      operations.push('index:'+input.runtimeProfileId)
      return {indexed:2}
    },
    async captureInstallation(input:{runtimeProfileId?:string}){
      operations.push('capture:'+input.runtimeProfileId)
      return {dispose:async()=>{operations.push('dispose:'+input.runtimeProfileId)}}
    },
  }
  const sources={list:()=>[
    {manifest:{sourceId:'pi',productId:'pi'},detect:async()=>[],startCapture:async()=>({})},
    {manifest:{sourceId:'disabled',productId:'pi'},detect:async()=>[],startCapture:async()=>({})},
  ]} as never
  const policy={isSourceEnabled:(id:string)=>id==='pi'}
  const coordinator=new SlimSourceCoordinator(runtime as never,sources,policy)
  coordinator.start()
  for(let i=0;i<100&&!coordinator.snapshot().finished;i++)await new Promise(
    resolve=>setImmediate(resolve))
  assert.equal(coordinator.snapshot().finished,true)
  assert.deepEqual(operations,[
    'index:profile-a','capture:profile-a','index:profile-b','capture:profile-b',
  ])
  assert.equal(coordinator.snapshot().runningCaptures,2)
  assert.equal(coordinator.snapshot().indexedSessions,4)
  await coordinator.dispose()
  assert.deepEqual(operations.slice(4),['dispose:profile-b','dispose:profile-a'])
})

test('failed indexing never starts capture or falls back to legacy history',async()=>{
  let captured=0
  const coordinator=new SlimSourceCoordinator({
    async resolveHost(){return {id:'host-1'}},
    async resolveInstallation(){return {id:'i'}},
    async resolveProfile(){return {id:'profile-1'}},
    async facets(){return {installedProducts:[{productId:'pi',installationIds:['i']}]}},
    async profiles(){return []},
    async reindexInstallation(){throw Error('source missing')},
    async captureInstallation(){captured++;throw Error('must not run')},
  } as never,{list:()=>[{manifest:{sourceId:'pi',productId:'pi'},detect:async()=>[],startCapture(){}}]} as never,
  {isSourceEnabled:()=>true})
  coordinator.start()
  for(let i=0;i<100&&!coordinator.snapshot().finished;i++)await new Promise(
    resolve=>setImmediate(resolve))
  assert.equal(captured,0)
  assert.equal(coordinator.snapshot().failedScopes,1)
  await coordinator.dispose()
})


test('fresh Slim installation is discovered before the first native index without a Legacy Writer',async()=>{
  const calls:string[]=[]
  const runtime={
    async resolveHost(input:{name:string;platform:string;arch:string}){
      assert.ok(input.name&&input.platform&&input.arch)
      calls.push('host')
      return {id:'local-host'}
    },
    async resolveInstallation(input:{productId:string;hostId:string;dataRoot?:string}){
      assert.equal(input.hostId,'local-host')
      assert.equal(input.productId,'pi')
      assert.equal(input.dataRoot,'/original/pi')
      calls.push('installation')
      return {id:'new-install'}
    },
    async resolveProfile(input:{installationId:string;nativeProfileId:string;dataRoot?:string}){
      assert.equal(input.installationId,'new-install')
      assert.equal(input.nativeProfileId,'profile-1')
      assert.equal(input.dataRoot,'/original/pi/profile-1')
      calls.push('profile')
      return {id:'new-profile'}
    },
    async facets(){calls.push('facets');return {
      installedProducts:[{productId:'pi',installationIds:['new-install']}],
    }},
    async profiles(){return [{id:'new-profile',installationId:'new-install'}]},
    async reindexInstallation(input:{runtimeProfileId?:string}){
      assert.equal(input.runtimeProfileId,'new-profile')
      calls.push('reindex')
      return {indexed:1}
    },
    async captureInstallation(input:{runtimeProfileId?:string}){
      assert.equal(input.runtimeProfileId,'new-profile')
      calls.push('capture')
      return {dispose:async()=>{calls.push('dispose')}}
    },
  }
  const source={
    manifest:{sourceId:'pi',productId:'pi'},
    detect:async()=>{
      calls.push('detect')
      return [{sourceId:'pi',productId:'pi',confidence:'high',
        dataRoot:'/original/pi',runtimeProfile:{
          nativeProfileId:'profile-1',dataRoot:'/original/pi/profile-1',
        }}]
    },
    startCapture:async()=>({dispose(){}}),
  }
  const coordinator=new SlimSourceCoordinator(runtime as never,
    {list:()=>[source]} as never,{isSourceEnabled:()=>true})
  coordinator.start()
  for(let i=0;i<100&&!coordinator.snapshot().finished;i++)await new Promise(
    resolve=>setImmediate(resolve))
  assert.equal(coordinator.snapshot().failedScopes,0)
  assert.deepEqual(calls,['host','detect','installation','profile','facets','reindex','capture'])
  await coordinator.dispose()
  assert.equal(calls.at(-1),'dispose')
})

test('failed Source.detect preserves pre-existing Slim catalog and never invokes old sync',async()=>{
  const calls:string[]=[]
  const coordinator=new SlimSourceCoordinator({
    async resolveHost(){return {id:'host'}},
    async resolveInstallation(){throw Error('must not insert')},
    async resolveProfile(){throw Error('must not insert')},
    async facets(){calls.push('facets');return {installedProducts:[]}},
    async profiles(){return []},
    async reindexInstallation(){throw Error('must not reindex')},
    async captureInstallation(){throw Error('must not capture')},
  } as never,{list:()=>[{manifest:{sourceId:'pi',productId:'pi'},
    detect:async()=>{throw Error('discovery unavailable')}}]} as never,
  {isSourceEnabled:()=>true})
  coordinator.start()
  for(let i=0;i<100&&!coordinator.snapshot().finished;i++)await new Promise(
    resolve=>setImmediate(resolve))
  assert.equal(coordinator.snapshot().finished,true)
  assert.equal(coordinator.snapshot().failedScopes,1)
  assert.deepEqual(calls,['facets'])
  await coordinator.dispose()
})


test('Slim asset scan runs after bounded native Catalog indexing and never blocks capture on failure',async()=>{
  const calls:string[]=[]
  const runtime={
    async resolveHost(){return {id:'host'}},
    async resolveInstallation(){return {id:'install'}},
    async resolveProfile(){return {id:'profile'}},
    async facets(){return {installedProducts:[{productId:'pi',installationIds:['install']}]}},
    async profiles(){return []},
    async reindexInstallation(){calls.push('index');return {indexed:1}},
    async scanInstallationAssets(input:{source:{manifest:{sourceId:string}}}){
      assert.equal(input.source.manifest.sourceId,'pi')
      calls.push('assets')
      throw new Error('asset source temporarily unavailable')
    },
    async captureInstallation(){calls.push('capture');return {dispose:async()=>{
      calls.push('dispose')
    }}},
  }
  const source={
    manifest:{sourceId:'pi',productId:'pi'},detect:async()=>[],
    discoverAssets:async function*(){yield {definition:{type:'skill',canonicalName:'demo'}}},
    startCapture:async()=>({dispose(){}}),
  }
  const policy={isSourceEnabled:()=>true,isEnabled:()=>true,
    sanitizeDiscoveredAsset:(x:unknown)=>x}
  const coordinator=new SlimSourceCoordinator(runtime as never,{list:()=>[source]} as never,
    policy,policy as never)
  coordinator.start()
  for(let i=0;i<100&&!coordinator.snapshot().finished;i++)await new Promise(
    resolve=>setImmediate(resolve))
  assert.deepEqual(calls,['index','assets','capture'])
  assert.equal(coordinator.snapshot().failedScopes,1)
  await coordinator.dispose()
  assert.equal(calls.at(-1),'dispose')
})
