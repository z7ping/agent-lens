import assert from 'node:assert/strict'
import test from 'node:test'
import type { AssetStateObservation, SourceDefinition } from '@agent-lens/core'
import { NativeOnlyAssetScanner } from './native-only-asset-scanner'

const at='2026-10-26T09:00:00Z'
test('native-only asset scan reconciles current state without creating Evidence',async()=>{
  let discover=true
  const stored:AssetStateObservation[]=[]
  const checkpoints=new Map<string,unknown>()
  const scanner=new NativeOnlyAssetScanner({
    async resolveDefinition(input){return {id:'asset',...input}},
    async resolveBinding(input){return {id:'binding',...input}},
    async recordState(input){
      const value={id:'state',...input}
      stored.push(value)
      return value
    },
  },{
    async get(_scope,key){return checkpoints.get(key)??null},
    async set(_scope,key,value){checkpoints.set(key,value)},
  } as never,{
    isEnabled(){return true},
    isSourceEnabled(){return true},
    sanitizeDiscoveredAsset(input){return input},
  } as never)
  const source={
    manifest:{sourceId:'pi',productId:'pi'},
    async *discoverAssets(){
      if(discover)yield{
        definition:{type:'skill',canonicalName:'review'},
        binding:{path:'/skills/review'},
        states:[{state:'installed',value:true,observedAt:at,
          evidenceCandidates:[{secret:'must-not-copy'}]}],
      }
    },
  } as unknown as SourceDefinition
  const input={
    source,signal:new AbortController().signal,
    host:{id:'h',name:'local',platform:'linux',arch:'x64',createdAt:at,lastSeenAt:at},
    installation:{id:'i',hostId:'h',productId:'pi',firstSeenAt:at,lastSeenAt:at},
  }
  const first=await scanner.scan(input as never)
  assert.equal(first.assetsDiscovered,1)
  assert.equal(first.statesRecorded,1)
  assert.deepEqual(stored[0]?.evidenceRefs,[])
  assert.equal(first.eventCopiesWritten,0)
  discover=false
  const second=await scanner.scan(input as never)
  assert.equal(second.assetsRemoved,1)
  assert.equal(second.statesCleared,1)
  assert.equal(stored[1]?.value,false)
  assert.deepEqual(stored[1]?.evidenceRefs,[])
})
