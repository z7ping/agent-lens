import assert from 'node:assert/strict'
import test from 'node:test'
import { SlimSourceCoordinator } from './slim-source-coordinator'

test('Slim coordinator indexes per Profile first, captures only authorized Source and stops cleanly',async()=>{
  const operations:string[]=[]
  const runtime={
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
    {manifest:{sourceId:'pi',productId:'pi'},startCapture:async()=>({})},
    {manifest:{sourceId:'disabled',productId:'pi'},startCapture:async()=>({})},
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
    async facets(){return {installedProducts:[{productId:'pi',installationIds:['i']}]}},
    async profiles(){return []},
    async reindexInstallation(){throw Error('source missing')},
    async captureInstallation(){captured++;throw Error('must not run')},
  } as never,{list:()=>[{manifest:{sourceId:'pi',productId:'pi'},startCapture(){}}]} as never,
  {isSourceEnabled:()=>true})
  coordinator.start()
  for(let i=0;i<100&&!coordinator.snapshot().finished;i++)await new Promise(
    resolve=>setImmediate(resolve))
  assert.equal(captured,0)
  assert.equal(coordinator.snapshot().failedScopes,1)
  await coordinator.dispose()
})
