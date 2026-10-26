import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceDefinition } from '@agent-lens/core'
import { auditNativeSessionOriginal } from './native-session-deep-audit'

const at='2026-10-26T00:00:00.000Z'
async function fixture(callback:(base:{
  input:Parameters<typeof auditNativeSessionOriginal>[0],
  changeSource:(opts:{drift?:boolean;pending?:boolean})=>void
})=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),'agent-lens-native-full-'))
  const path=join(dir,'session.jsonl')
  await writeFile(path,'one\ntwo\n')
  try{
    const info=await stat(path)
    const entry={
      sourceId:'pi',installationId:'install',nativeSessionId:'s',
      locationKind:'native' as const,filePath:path,fileIdentity:`${info.dev}:${info.ino}`,
      fileSize:info.size,fileMtimeMs:info.mtimeMs,lastActivityAt:at,updatedAt:at,
    }
    let opts={drift:false,pending:false}
    const source={
      manifest:{sourceId:'pi',productId:'pi',pluginType:'source',parserVersion:'v1'},
      readNativeSessionPage:async(query:{
        filePath:string;nativeSessionId:string;cursor?:{offset:number}
      })=>{
        const second=(query.cursor?.offset??0)>0
        return {
          state:'available',hasMore:!second,pendingTail:opts.pending,
          nextCursor:{fileIdentity:entry.fileIdentity,
            offset:second?8:4,sequence:second?2:1},
          records:[{
            id:second?'row-2':'row-1',
            sourceId:entry.sourceId,installationId:entry.installationId,
            sourceSessionNativeId:opts.drift?'wrong':'s',
            nativeType:'history/message',capturedAt:at,parserVersion:'v1',
            locator:{kind:'file',path,offset:second?4:0},
            fingerprint:second?'fingerprint-2':'fingerprint-1',payload:{},
          }],
        }
      },
      rawRecovery:{
        verify:async()=>({state:'verified',checkedAt:at}),
      },
    } as unknown as SourceDefinition
    const input={
      source,entry,
      host:{id:'host',name:'localhost',platform:'linux',arch:'x64',
        createdAt:at,lastSeenAt:at},
      installation:{id:'install',hostId:'host',productId:'pi',
        dataRoot:dir,firstSeenAt:at,lastSeenAt:at},
      signal:new AbortController().signal,
    }
    await callback({input,changeSource:next=>{opts={...opts,...next}}})
  }finally{await rm(dir,{recursive:true,force:true})}
}

test('full original audit verifies each page and current source revision without persisting payload',async()=>{
  await fixture(async({input})=>{
    assert.deepEqual(await auditNativeSessionOriginal(input),{
      state:'verified',pages:2,records:2,nativeContentVerified:true,
    })
  })
})
test('full original audit never declares only the first verified page complete',async()=>{
  await fixture(async({input})=>{
    const result=await auditNativeSessionOriginal({...input,maxPages:1})
    assert.equal(result.state,'partial')
    assert.equal(result.nativeContentVerified,false)
    assert.equal(result.records,1)
  })
})
test('native audit reports pending tail and foreign record identities',async()=>{
  await fixture(async({input,changeSource})=>{
    changeSource({pending:true})
    assert.equal((await auditNativeSessionOriginal(input)).state,'partial')
    changeSource({pending:false,drift:true})
    assert.equal((await auditNativeSessionOriginal(input)).state,'drifted')
  })
})
test('native audit requires a bounded record/page budget',async()=>{
  await fixture(async({input})=>{
    await assert.rejects(auditNativeSessionOriginal({...input,pageSize:65}),/budget/)
    await assert.rejects(auditNativeSessionOriginal({...input,maxPages:16385}),/budget/)
  })
})
