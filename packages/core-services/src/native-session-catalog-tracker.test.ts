import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  NativeSessionCatalogEntry,
  NativeSessionCatalogStore,
  SourceDefinition,
  SourceRecord,
} from '@agent-lens/core'
import { NativeSessionCatalogTracker } from './native-session-catalog-tracker'

const at = '2026-10-25T00:00:00Z'
const accepted = { authority: 'native-store', canReread: true }
const source = {
  manifest: { sourceId: 'pi' },
  readNativeSessionPage() {},
  rawRecovery: { describe: () => accepted },
} as unknown as SourceDefinition
const record = (path: string): SourceRecord => ({
  id: 'native-record', sourceId: 'pi', installationId: 'pi-installed',
  sourceSessionNativeId: 'pi-original', nativeType: 'history/message',
  capturedAt: at, locator: { kind: 'file', path, offset: 0 },
  fingerprint: 'test', parserVersion: '1',
  payload: { entry: { message: { content: 'DO_NOT_PERSIST' } } },
})

test('incremental tracker writes only metadata once per native file window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-catalog-track-'))
  const path = join(root, 'session.jsonl')
  const stored: NativeSessionCatalogEntry[] = []
  const catalog = { async upsert(entry: NativeSessionCatalogEntry) { stored.push(entry) } } as NativeSessionCatalogStore
  let now = Date.parse(at)
  const tracker = new NativeSessionCatalogTracker(catalog, () => now, 30_000)
  try {
    await writeFile(path, '{"type":"session","id":"pi-original"}\n')
    assert.equal(await tracker.observe(source, record(path)), true)
    assert.equal(stored.length, 1)
    assert.equal(stored[0]?.sourceId, 'pi')
    assert.equal(stored[0]?.nativeSessionId, 'pi-original')
    assert.equal(stored[0]?.locationKind, 'native')
    assert.equal(stored[0]?.filePath, path)
    assert.equal(Object.keys(stored[0]!).some(key => key.includes('payload') || key.includes('observation')), false)
    assert.equal(JSON.stringify(stored).includes('DO_NOT_PERSIST'), false)

    await appendFile(path, '{"type":"message","id":"one"}\n')
    assert.equal(await tracker.observe(source, record(path)), false)
    assert.equal(stored.length, 1)
    now += 30_001
    assert.equal(await tracker.observe(source, record(path)), true)
    assert.equal(stored.length, 2)
    assert.ok(stored[1]!.fileSize > stored[0]!.fileSize)

    await rm(path)
    now += 30_001
    assert.equal(await tracker.observe(source, record(path)), false)
    // Missing/inaccessible != confirmed deletion: existing catalog stays intact.
    assert.equal(stored.length, 2)
    // Same clock tick: successful index must not be throttled by the failed stat.
    await writeFile(path,'{"type":"session","id":"pi-original"}\n')
    assert.equal(await tracker.observe(source, record(path)), true)
    assert.equal(stored.length, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tracker rejects non-native records and sources without native reader capability', async () => {
  const stored: NativeSessionCatalogEntry[] = []
  const catalog = { async upsert(entry: NativeSessionCatalogEntry) { stored.push(entry) } } as NativeSessionCatalogStore
  const tracker = new NativeSessionCatalogTracker(catalog)
  const recordAtPath = record('/not-existing/session.jsonl')
  assert.equal(await tracker.observe(source, { ...recordAtPath, locator: { kind: 'runtime-hook', hookEventId: 'h' } }), false)
  const { sourceSessionNativeId: _nativeSessionId, ...withoutSessionId } = recordAtPath
  assert.equal(await tracker.observe(source, withoutSessionId), false)
  assert.equal(await tracker.observe(source, { ...recordAtPath, sourceId: 'codex' }), false)
  const { readNativeSessionPage: _reader, ...withoutNativeReader } = source
  assert.equal(await tracker.observe(withoutNativeReader as SourceDefinition, recordAtPath), false)
  assert.deepEqual(stored, [])
})

test('native SQLite catalog observes real message clock through WAL mtime throttle',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-catalog-sqlite-'))
  const path=join(root,'state.db')
  const stored:NativeSessionCatalogEntry[]=[]
  const catalog={ async upsert(entry:NativeSessionCatalogEntry){stored.push(entry)} } as NativeSessionCatalogStore
  let now=Date.parse(at)
  const tracker=new NativeSessionCatalogTracker(catalog,()=>now,30_000)
  const dbSource={
    manifest:{sourceId:'hermes'},readNativeSessionPage(){},
    rawRecovery:{describe:()=>accepted},
  } as unknown as SourceDefinition
  const atOffset=(minute:number):SourceRecord=>({
    ...record(path),sourceId:'hermes',occurredAt:new Date(now+minute*60_000).toISOString(),
    locator:{kind:'database',path,table:'messages',rowId:String(minute+1)},
  })
  try{
    await writeFile(path,'fake source-owned database file for metadata-only tracking')
    assert.equal(await tracker.observe(dbSource,atOffset(0)),true)
    assert.equal(await tracker.observe(dbSource,atOffset(2)),false)
    assert.equal(await tracker.observe(dbSource,atOffset(6)),true)
    assert.equal(stored.length,2)
    assert.equal(stored[0]?.lastActivityAt,new Date(now).toISOString())
    assert.equal(stored[1]?.lastActivityAt,new Date(now+6*60_000).toISOString())
    assert.equal(JSON.stringify(stored).includes('DO_NOT_PERSIST'),false)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('catalog indexes native session titles only, never user/tool content',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-catalog-title-'))
  const path=join(root,'session.jsonl')
  const stored:NativeSessionCatalogEntry[]=[]
  const catalog={async upsert(entry:NativeSessionCatalogEntry){stored.push(entry)}} as NativeSessionCatalogStore
  let now=Date.parse(at)
  const tracker=new NativeSessionCatalogTracker(catalog,()=>now,30_000)
  try{
    await writeFile(path,'{}\n')
    const transcript={...record(path),payload:{
      session:{nativeSessionId:'pi-original'},
      entry:{type:'message',message:{role:'user',content:'PRIVATE_PROMPT'},title:'untrusted-message-title'},
    }}
    assert.equal(await tracker.observe(source,transcript),true)
    assert.equal(stored[0]?.title,undefined)
    assert.equal(JSON.stringify(stored).includes('PRIVATE_PROMPT'),false)
    const titled={...record(path),payload:{
      session:{nativeSessionId:'pi-original',sessionName:'Native title'},
      entry:{type:'message',message:{role:'assistant',content:'PRIVATE_RESPONSE'}},
    }}
    assert.equal(await tracker.observe(source,titled),true)
    assert.equal(stored[1]?.title,'Native title')
    assert.equal(JSON.stringify(stored).includes('PRIVATE_RESPONSE'),false)
    // A repeated user turn must not replace a trusted title or force a write.
    assert.equal(await tracker.observe(source,transcript),false)
    assert.equal(stored.length,2)
    now+=30_001
    assert.equal(await tracker.observe(source,transcript),true)
    assert.equal(stored[2]?.title,undefined) // SQL upsert keeps previous native title.
    assert.equal(await tracker.observe(source,{
      ...record(path),payload:{entry:{type:'session_info',name:'Explicit new title'}},
    }),true)
    assert.equal(stored[3]?.title,'Explicit new title')
  }finally{await rm(root,{recursive:true,force:true})}
})

test('failed catalog upsert is not remembered as an indexed session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-index-retry-'))
  const path=join(root,'session.jsonl')
  let attempts=0
  const catalog={async upsert(){attempts++;if(attempts===1)throw Error('writer busy')}}
    as unknown as NativeSessionCatalogStore
  const tracker=new NativeSessionCatalogTracker(catalog,()=>1_000,30_000)
  try {
    await writeFile(path,'{}\n')
    await assert.rejects(()=>tracker.observe(source,record(path)),/writer busy/)
    assert.equal(await tracker.observe(source,record(path)),true)
    assert.equal(attempts,2)
  }finally{await rm(root,{recursive:true,force:true})}
})
