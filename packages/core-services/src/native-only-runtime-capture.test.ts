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
      async startCapture(_ctx,emitter){
        await emitter.emit(record)
        return {dispose(){}}
      },
    } as unknown as SourceDefinition
    const runner=new NativeOnlyRuntimeCapture({
      nativeSessionCatalog:{
        async upsert(entry){upserts.push(entry)},
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

test('uncertified runtime-only Hook increments gap instead of writing Evidence or claiming coverage',async()=>{
  const upserts:unknown[]=[]
  const source={
    manifest:{sourceId:'hermes',productId:'hermes'},
    readNativeSessionPage:async()=>({state:'unsupported'}),
    rawRecovery:{verify:async()=>({state:'verified'})},
    async startCapture(_ctx,emitter){
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
    nativeSessionCatalog:{async upsert(entry){upserts.push(entry)}} as never,
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
