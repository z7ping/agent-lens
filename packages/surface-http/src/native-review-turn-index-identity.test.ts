import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapturePolicyService, NativeSessionCatalogEntry, ObservationCandidate,
  SourceNativeSessionCursor, SourceService } from '@agent-lens/core'
import type { NativeSessionWindowReader } from './native-session-http'
import { NativeReviewTurnIndex, type NativeTurnIndexCheckpointStore } from './native-review-turn-index-http'

test('full-range original identity lookup validates uniqueness and physical file revision',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-lookup-'))
  const file=join(root,'original.jsonl')
  try{
    const idFor=(n:number)=>n===700||n===705?'duplicate-key':`u-${n}`
    const records=Array.from({length:1100},(_,n)=>({
      id:idFor(n),type:'message',message:{role:'user',content:`message-${n}`},
    }))
    await writeFile(file,records.map(x=>JSON.stringify(x)).join('\n')+'\n')
    const info=await stat(file)
    const id='native:'+'b'.repeat(32)
    const entry:NativeSessionCatalogEntry={
      sourceId:'pi',installationId:'inst',nativeSessionId:'s',locationKind:'native',
      filePath:file,fileIdentity:`${info.dev}:${info.ino}`,
      fileSize:info.size,fileMtimeMs:info.mtimeMs,
      lastActivityAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z',
    }
    const checkpoints=new Map<string,unknown>()
    const store:NativeTurnIndexCheckpointStore={
      async get<T>(scope:string,key:string){return checkpoints.get(scope+'|'+key) as T??null},
      async set(scope:string,key:string,value:unknown){checkpoints.set(scope+'|'+key,value)},
    }
    const sources={list:()=>[{manifest:{sourceId:'pi',parserVersion:'8'},
      readNativeSessionPage:()=>undefined}]} as unknown as SourceService
    const policy={isSourceEnabled:()=>true} as unknown as CapturePolicyService
    let reads=0
    const reader:NativeSessionWindowReader={async read(query){
      reads++
      const start=query.cursor?.offset??0
      const end=Math.min(records.length,start+(query.limit??16))
      const cursor=(n:number):SourceNativeSessionCursor=>({
        fileIdentity:entry.fileIdentity,offset:n,sequence:n,
      })
      const observations=records.slice(start,end).map(r=>({
        kind:'message.user',nativeEventId:r.id,capturedAt:'2026-11-01T00:00:00.000Z',
        payload:{text:r.message.content},
      })) as ObservationCandidate[]
      return {state:'available',observations,
        observationRecordIds:observations.map((_,i)=>`record-${i+start}`),
        observationCursors:observations.map((_,i)=>cursor(i+start)),
        evidenceCandidates:[],nextCursor:cursor(end),
        hasMore:end<records.length,pendingTail:false}
    }}
    const index=new NativeReviewTurnIndex(reader,
      {getByReviewSessionId:async()=>entry},store,sources,policy)
    assert.equal(await index.findByNativeEventId(id,'u-1099',file),undefined,
      'a partial index cannot prove identity uniqueness')
    for(let n=0;n<6;n++){
      const progress=await index.query(id,{scan:true,tail:1})
      assert.equal(progress.state,'available')
      if(progress.state==='available'&&progress.coverage==='complete')break
    }
    const before=reads
    const found=await index.findByNativeEventId(id,'u-1099',file)
    assert.equal(found?.ordinal,1100,'a Live ordinal near 1 cannot constrain the file lookup')
    assert.equal(found?.nativeEventId,'u-1099')
    assert.equal(reads,before,'lookup reads only stored metadata, never Source content')
    assert.equal(await index.findByNativeEventId(id,'duplicate-key',file),undefined,
      'duplicates in different 64-turn blocks must fail closed')
    assert.equal(await index.findByNativeEventId(id,'u-1099',join(root,'different.jsonl')),
      undefined,'no correspondence to a different physical source file')
    await appendFile(file,' ')
    assert.equal(await index.findByNativeEventId(id,'u-1099',file),undefined,
      'live locator must not use a stale file revision')
  }finally{await rm(root,{recursive:true,force:true})}
})
