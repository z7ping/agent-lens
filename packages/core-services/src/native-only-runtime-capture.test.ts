import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceDefinition, SourceRecord } from '@agent-lens/core'
import { NativeOnlyRuntimeCapture } from './native-only-runtime-capture'

const at='2026-10-26T00:00:00.000Z'
test('native runtime capture verifies original and updates Catalog/metrics without Legacy events',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentlens-capture-'))
  const file=join(root,'session.jsonl')
  await writeFile(file,'{"type":"user"}\n')
  const upserts:unknown[]=[],invalidations:unknown[]=[]
  try{
    const record:SourceRecord={
      id:'r1',sourceId:'pi',installationId:'install',
      sourceSessionNativeId:'native-1',
      nativeType:'message',capturedAt:at,parserVersion:'1',
      locator:{kind:'file',path:file,offset:0},
      fingerprint:'original-fingerprint',payload:{text:'must never be copied'},
    }
    const source={
      manifest:{sourceId:'pi',productId:'pi'},
      readNativeSessionPage:async()=>({state:'unsupported'}),
      rawRecovery:{
        describe:()=>({canReread:true}),
        verify:async()=>({state:'verified',checkedAt:at}),
      },
      async startCapture(_ctx:Parameters<NonNullable<SourceDefinition['startCapture']>>[0],emitter:Parameters<NonNullable<SourceDefinition['startCapture']>>[1]){
        await emitter.emit(record)
        return {dispose(){}}
      },
    } as unknown as SourceDefinition
    const runner=new NativeOnlyRuntimeCapture({
      nativeSessionCatalog:{
        async upsert(entry:import('@agent-lens/core').NativeSessionCatalogEntry){upserts.push(entry)},
      } as never,
      nativeSessionMetrics:{async invalidate(identity){invalidations.push(identity)}},
      checkpoints:{async get(){return null},async set(){},async clear(){}},
    })
    const handle=await runner.start({
      source,
      host:{id:'host',name:'local',platform:'linux',arch:'x64',createdAt:at,lastSeenAt:at},
      installation:{id:'install',hostId:'host',productId:'pi',
        dataRoot:root,firstSeenAt:at,lastSeenAt:at},
      signal:new AbortController().signal,
    })
    const snapshot=handle.snapshot()
    assert.equal(snapshot.received,1)
    assert.equal(snapshot.sourceVerified,1)
    assert.equal(snapshot.catalogUpdated,1)
    assert.equal(snapshot.metricsInvalidated,1)
    assert.equal(snapshot.eventCopiesWritten,0)
    assert.equal(upserts.length,1)
    assert.equal(invalidations.length,1)
    assert.equal(JSON.stringify(upserts).includes('must never be copied'),false)
    await handle.dispose()
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Pi native capture accepts fractional file timestamps in bounded cursors',async()=>{
  const checkpoints=new Map<string,unknown>()
  const key='pi:history:v6-file-identity:abc'
  const cursor={path:'/tmp/session.jsonl',offset:123,sequence:1,
    size:234,mtimeMs:1780000000123.375,fileId:'1:2'}
  const source={
    manifest:{sourceId:'pi',productId:'pi'},
    readNativeSessionPage:async()=>({state:'unsupported'}),
    rawRecovery:{verify:async()=>({state:'verified'})},
    async startCapture(ctx:Parameters<NonNullable<SourceDefinition['startCapture']>>[0]){
      await ctx.checkpoint.set(key,cursor)
      assert.deepEqual(await ctx.checkpoint.get(key),cursor)
      await assert.rejects(ctx.checkpoint.set('invalid',{mtimeMs:Infinity}),/bounded cursor metadata/)
      await assert.rejects(ctx.checkpoint.set('invalid',{content:'not-a-cursor'}),/bounded cursor metadata/)
      return {dispose(){}}
    },
  } as unknown as SourceDefinition
  const runner=new NativeOnlyRuntimeCapture({
    nativeSessionCatalog:{async upsert(){}} as never,
    checkpoints:{
      async get(_scope:string,key:string){return checkpoints.get(key)??null},
      async set(_scope:string,key:string,value:unknown){checkpoints.set(key,value)},
      async clear(_scope:string,key:string){checkpoints.delete(key)},
    } as never,
  })
  const handle=await runner.start({
    source,
    host:{id:'host',name:'local',platform:'linux',arch:'x64',createdAt:at,lastSeenAt:at},
    installation:{id:'install',hostId:'host',productId:'pi',
      firstSeenAt:at,lastSeenAt:at},
    signal:new AbortController().signal,
  })
  assert.equal(checkpoints.size,1)
  await handle.dispose()
})

test('Slim capture writes verified native Profile association before Catalog visibility',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentlens-profile-capture-'))
  const file=join(root,'native.jsonl')
  await writeFile(file,'{"type":"user"}\n')
  const sequence:string[]=[]
  const contextWrites:Array<{runtimeProfileId?:string;nativeSessionId:string}>=[]
  const record:SourceRecord={
    id:'rec',sourceId:'pi',installationId:'install',
    sourceSessionNativeId:'profile-session',nativeType:'message',capturedAt:at,
    parserVersion:'1',locator:{kind:'file',path:file,offset:0},
    fingerprint:'verified-native-only',payload:{text:'must stay in source'},
  }
  const source={
    manifest:{sourceId:'pi',productId:'pi'},
    readNativeSessionPage:async()=>({state:'unsupported'}),
    rawRecovery:{describe:()=>({canReread:true}),
      verify:async()=>({state:'verified',checkedAt:at})},
    async startCapture(_ctx:Parameters<NonNullable<SourceDefinition['startCapture']>>[0],emitter:Parameters<NonNullable<SourceDefinition['startCapture']>>[1]){await emitter.emit(record);return{dispose(){}}},
  } as unknown as SourceDefinition
  const host={id:'host',name:'local',platform:'linux',arch:'x64',
    createdAt:at,lastSeenAt:at}
  const installation={id:'install',hostId:'host',productId:'pi',
    dataRoot:root,firstSeenAt:at,lastSeenAt:at}
  const profile={id:'profile-1',installationId:'install',
    nativeProfileId:'project-profile',dataRoot:root,firstSeenAt:at,lastSeenAt:at}
  try{
    const capture=new NativeOnlyRuntimeCapture({
      nativeSessionCatalog:{async upsert(){sequence.push('catalog')}} as never,
      nativeSessionContexts:{async upsert(input){
        sequence.push('context')
        contextWrites.push(input)
      }},
      checkpoints:{async get(){return null},async set(){},async clear(){}},
    })
    const handle=await capture.start({source,host,installation,runtimeProfile:profile,
      signal:new AbortController().signal})
    assert.deepEqual(sequence,['context','catalog'])
    assert.deepEqual(contextWrites,[{sourceId:'pi',installationId:'install',
      nativeSessionId:'profile-session',runtimeProfileId:'profile-1'}])
    assert.equal(JSON.stringify(contextWrites).includes('must stay in source'),false)
    await handle.dispose()
    const missingAssociation=new NativeOnlyRuntimeCapture({
      nativeSessionCatalog:{async upsert(){throw Error('must not write')}} as never,
      checkpoints:{async get(){return null},async set(){},async clear(){}},
    })
    await assert.rejects(missingAssociation.start({source,host,installation,
      runtimeProfile:profile,signal:new AbortController().signal}),/durable runtime profile/)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('verified native tail records attach workspace once per session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentlens-workspace-capture-'))
  const file=join(root,'native.jsonl')
  await writeFile(file,'{"type":"session"}\n')
  const workspaces:string[]=[]
  const contexts:unknown[]=[]
  try{
    const record:SourceRecord={
      id:'native-one',sourceId:'pi',installationId:'install',
      sourceSessionNativeId:'native-1',nativeType:'history/session',
      capturedAt:at,parserVersion:'1',
      locator:{kind:'file',path:file,offset:0},
      fingerprint:'verified-session',
      payload:{entry:{type:'session'},session:{cwd:root}},
    }
    const source={
      manifest:{sourceId:'pi',productId:'pi'},
      readNativeSessionPage:async()=>({state:'unsupported'}),
      rawRecovery:{
        describe:()=>({canReread:true}),
        verify:async()=>({state:'verified'}),
      },
      async startCapture(_ctx:Parameters<NonNullable<SourceDefinition['startCapture']>>[0],
        emitter:Parameters<NonNullable<SourceDefinition['startCapture']>>[1]){
        await emitter.emit(record)
        await emitter.emit({...record,id:'native-two'})
        return {dispose(){}}
      },
    } as unknown as SourceDefinition
    const runner=new NativeOnlyRuntimeCapture({
      nativeSessionCatalog:{async upsert(){}} as never,
      identity:{async resolveWorkspace(input){
        assert.ok(input.path)
        workspaces.push(input.path)
        return {id:'ws-1',hostId:'host',path:root,projectId:'prj-1'}
      }},
      nativeSessionContexts:{async upsert(input){contexts.push(input)}},
      checkpoints:{async get(){return null},async set(){},async clear(){}},
    })
    const handle=await runner.start({
      source,
      host:{id:'host',name:'local',platform:'linux',arch:'x64',createdAt:at,lastSeenAt:at},
      installation:{id:'install',hostId:'host',productId:'pi',
        dataRoot:root,firstSeenAt:at,lastSeenAt:at},
      signal:new AbortController().signal,
    })
    assert.deepEqual(workspaces,[root])
    assert.deepEqual(contexts,[{
      sourceId:'pi',installationId:'install',nativeSessionId:'native-1',
      workspaceId:'ws-1',projectId:'prj-1',
    }])
    await handle.dispose()
  }finally{await rm(root,{recursive:true,force:true})}
})

test('uncertified runtime-only Hook increments gap instead of writing Evidence or claiming coverage',async()=>{
  const upserts:unknown[]=[]
  const source={
    manifest:{sourceId:'hermes',productId:'hermes'},
    readNativeSessionPage:async()=>({state:'unsupported'}),
    rawRecovery:{verify:async()=>({state:'verified'})},
    async startCapture(_ctx:Parameters<NonNullable<SourceDefinition['startCapture']>>[0],emitter:Parameters<NonNullable<SourceDefinition['startCapture']>>[1]){
      await emitter.emit({
        id:'hook',sourceId:'hermes',installationId:'install',
        sourceSessionNativeId:'native-1',nativeType:'tool',
        capturedAt:at,parserVersion:'1',fingerprint:'event',
        locator:{kind:'runtime-hook',path:'/tmp/hook'},payload:{prompt:'secret'},
      })
      return {dispose(){}}
    },
  } as unknown as SourceDefinition
  const runner=new NativeOnlyRuntimeCapture({
    nativeSessionCatalog:{async upsert(entry:import('@agent-lens/core').NativeSessionCatalogEntry){upserts.push(entry)}} as never,
    checkpoints:{async get(){return null},async set(){},async clear(){}},
  })
  const handle=await runner.start({
    source,
    host:{id:'host',name:'local',platform:'linux',arch:'x64',createdAt:at,lastSeenAt:at},
    installation:{id:'install',hostId:'host',productId:'hermes',
      firstSeenAt:at,lastSeenAt:at},
    signal:new AbortController().signal,
  })
  assert.equal(handle.snapshot().coverageGaps,1)
  assert.equal(handle.snapshot().eventCopiesWritten,0)
  assert.deepEqual(upserts,[])
  await handle.dispose()
})
