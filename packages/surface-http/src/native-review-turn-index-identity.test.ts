import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
    const lines=records.map(x=>JSON.stringify(x))
    const offsets=[0]
    for(const line of lines)offsets.push(offsets.at(-1)!+Buffer.byteLength(line,'utf8')+1)
    await writeFile(file,lines.join('\n')+'\n')
    const fixedTime=new Date('2026-01-01T00:00:00.000Z')
    await utimes(file,fixedTime,fixedTime)
    const info=await stat(file)
    const id='native:'+'b'.repeat(32)
    const entry:NativeSessionCatalogEntry={
      sourceId:'pi',installationId:'inst',nativeSessionId:'s',locationKind:'native',
      filePath:file,fileIdentity:`${info.dev}:${info.ino}`,
      fileSize:info.size,fileMtimeMs:info.mtimeMs,
      lastActivityAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z',
    }
    const checkpoints=new Map<string,unknown>()
    let blockReads=0
    const store:NativeTurnIndexCheckpointStore={
      async get<T>(scope:string,key:string){
        if(key.includes(':block:'))blockReads++
        return checkpoints.get(scope+'|'+key) as T??null
      },
      async set(scope:string,key:string,value:unknown){checkpoints.set(scope+'|'+key,value)},
    }
    const sources={list:()=>[{manifest:{sourceId:'pi',parserVersion:'8'},
      readNativeSessionPage:()=>undefined}]} as unknown as SourceService
    const policy={isSourceEnabled:()=>true} as unknown as CapturePolicyService
    let reads=0
    const reader:NativeSessionWindowReader={async read(query){
      reads++
      const start=query.cursor?offsets.indexOf(query.cursor.offset):0
      if(start<0)return {state:'drifted',reason:'native-file-cursor-drifted'}
      const end=Math.min(records.length,start+(query.limit??16))
      const cursor=(n:number):SourceNativeSessionCursor=>({
        fileIdentity:entry.fileIdentity,offset:offsets[n]!,sequence:n,
        ...(n<lines.length?{recordFingerprint:createHash('sha256')
          .update(lines[n]!).digest('hex')}:{}),
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
      'an incomplete index must not return an unverified locator')
    // The first user-triggered lookup starts bounded background hydration;
    // later requests can resume if the current budget was insufficient.
    let completed=false
    for(let attempt=0;attempt<100;attempt++){
      const progress=await index.query(id,{tail:1})
      if(progress.state==='available'&&progress.coverage==='complete'){
        completed=true
        break
      }
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(completed,true,'on-demand warmup should populate this small fixture')
    const before=reads
    const found=await index.findByNativeEventId(id,'u-1099',file)
    assert.equal(found?.ordinal,1100,'a Live ordinal near 1 cannot constrain the file lookup')
    assert.equal(found?.nativeEventId,'u-1099')
    assert.equal(reads,before,'lookup reads only stored metadata, never Source content')
    const blocksBefore=blockReads
    assert.equal((await index.findByNativeEventId(id,'u-1098',file))?.ordinal,1099)
    assert.equal(blockReads,blocksBefore,
      'a second full-range seek reuses bounded metadata-only identity cache')
    assert.equal(await index.findByNativeEventId(id,'duplicate-key',file),undefined,
      'duplicates in different 64-turn blocks must fail closed')
    assert.equal(await index.findByNativeEventId(id,'u-1099',join(root,'different.jsonl')),
      undefined,'no correspondence to a different physical source file')
    const modified=[...lines]
    modified[1099]=modified[1099]!.replace('message-1099','MESSAGE-1099')
    assert.equal(Buffer.byteLength(modified[1099]!),Buffer.byteLength(lines[1099]!))
    await writeFile(file,modified.join('\n')+'\n')
    await utimes(file,fixedTime,fixedTime)
    const overwritten=await stat(file)
    assert.equal(overwritten.size,info.size)
    assert.equal(overwritten.mtimeMs,info.mtimeMs)
    assert.equal(overwritten.ino,info.ino)
    assert.equal(await index.findByNativeEventId(id,'u-1099',file),undefined,
      'record SHA-256 rejects same-inode, same-size, same-mtime in-place overwrite')
    await appendFile(file,' ')
    assert.equal(await index.findByNativeEventId(id,'u-1099',file),undefined,
      'live locator must not use a stale appended file revision')
  }finally{await rm(root,{recursive:true,force:true})}
})
