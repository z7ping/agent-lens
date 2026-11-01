import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceRawRecoveryContext, SourceRecord } from '@agent-lens/core'
import { piManifest, piSourceDefinition } from './index'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

test('Pi: metadata-only reference hydrates an original event and reuses the original normalizer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-hydrate-'))
  const dataRoot = join(root, 'sessions')
  const path = join(dataRoot, 'session.jsonl')
  const header = JSON.stringify({ type: 'session', id: 'pi-original', cwd: '/workspace/test' })
  const event = JSON.stringify({
    type: 'message', id: 'user-entry-1',
    message: { role: 'user', content: 'hello from native Pi' },
  })
  const reference: SourceRecord = {
    id: 'pi-record-1',
    sourceId: 'pi', installationId: 'pi-installation',
    sourceSessionNativeId: 'pi-original',
    nativeType: 'history/message', nativeId: 'user-entry-1',
    sourceSequence: 2000, capturedAt: '2026-10-25T00:00:00Z',
    locator: { kind: 'file', path, offset: Buffer.byteLength(header + '\n') },
    fingerprint: hash(event), parserVersion: piManifest.parserVersion, payload: null,
  }
  const host: SourceRawRecoveryContext['host'] = {
    id: 'host-1', name: 'test', platform: process.platform, arch: process.arch,
    createdAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z',
  }
  const installation: SourceRawRecoveryContext['installation'] = {
    id: 'pi-installation', hostId: host.id, productId: 'pi', dataRoot,
    firstSeenAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z',
  }
  const ctx: SourceRawRecoveryContext = {
    host, installation, abortSignal: new AbortController().signal,
    checkpoint: { async get() { return null }, async set() {}, async clear() {} },
  }
  try {
    await mkdir(dataRoot, { recursive: true })
    await writeFile(path, header + '\n' + event + '\n', 'utf8')
    const hydrate = piSourceDefinition.rawRecovery!.hydrate!
    const actual = await hydrate(reference, ctx)
    assert.equal(actual.state, 'available')
    if (actual.state !== 'available') return
    assert.deepEqual(actual.record.payload, {
      entry: JSON.parse(event),
      session: { nativeSessionId: 'pi-original', cwd: '/workspace/test' },
    })
    const normalized = await piSourceDefinition.normalize(actual.record, { host, installation })
    assert.equal(normalized.observations.some(item => item.kind === 'message.user'), true)

    assert.deepEqual(await hydrate({ ...reference, parserVersion: 'old-parser' }, ctx), {
      state: 'incompatible', reason: 'source-parser-version-changed',
    })
    assert.deepEqual(await hydrate({ ...reference, installationId: 'different' }, ctx), {
      state: 'unsupported', reason: 'source-installation-mismatch',
    })
    const drifted = await hydrate({ ...reference, fingerprint: hash('wrong') }, ctx)
    assert.equal(drifted.state, 'drifted')
    assert.deepEqual(await hydrate({ ...reference, sourceSessionNativeId: 'other' }, ctx), {
      state: 'drifted', reason: 'source-native-session-identity-changed',
    })
    const outside = join(root, 'outside.jsonl')
    await writeFile(outside, header + '\n' + event + '\n', 'utf8')
    assert.deepEqual(await hydrate({
      ...reference, locator: { kind: 'file', path: outside, offset: reference.locator.offset! },
    }, ctx), { state: 'unsupported', reason: 'source-path-outside-authorized-roots' })

    const abort = new AbortController()
    abort.abort()
    await assert.rejects(hydrate(reference, { ...ctx, abortSignal: abort.signal }))
    await rm(path)
    assert.deepEqual(await hydrate(reference, ctx), { state: 'unavailable', reason: 'source-file-missing' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('Pi session page reads native messages by cursor without checkpoints or event persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-page-'))
  const path = join(root, 'session.jsonl')
  const header = JSON.stringify({ type: 'session', id: 'pi-page' })
  const message = (id: number) => JSON.stringify({ type: 'message', id: `msg-${id}`,
    message: { role: 'user', content: `turn ${id}` } })
  const host = { id: 'host', name: 'host', platform: process.platform, arch: process.arch,
    createdAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z' }
  const installation = { id: 'pi-page-inst', hostId: host.id, productId: 'pi', dataRoot: root,
    firstSeenAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z' }
  let checkpointCalls = 0
  const ctx: SourceRawRecoveryContext = { host, installation, abortSignal: new AbortController().signal,
    checkpoint: { async get() { checkpointCalls++; return null }, async set() { checkpointCalls++ },
      async clear() { checkpointCalls++ } } }
  try {
    await writeFile(path, [header, message(1), message(2)].join('\n') + '\n')
    const read = piSourceDefinition.readNativeSessionPage!
    const first = await read({ filePath: path, nativeSessionId: 'pi-page', limit: 2 }, ctx)
    assert.equal(first.state, 'available')
    if (first.state !== 'available') return
    assert.equal(first.records.length, 2)
    assert.deepEqual(first.recordCursors?.map(c => [c.offset,c.sequence]), [
      [0,0], [Buffer.byteLength(header+'\n'),1],
    ])
    assert.equal(first.hasMore, true)
    const next = await read({ filePath: path, nativeSessionId: 'pi-page', cursor: first.nextCursor, limit: 2 }, ctx)
    assert.equal(next.state, 'available')
    if (next.state !== 'available') return
    assert.deepEqual(next.records.map(x => x.nativeId), ['msg-2'])
    assert.equal(next.recordCursors?.[0]?.offset, first.nextCursor.offset)
    assert.equal(next.recordCursors?.[0]?.sequence, first.nextCursor.sequence)
    assert.equal(next.hasMore, false)
    assert.equal(checkpointCalls, 0)
    const normalized = await piSourceDefinition.normalize(next.records[0]!, { host, installation })
    assert.equal(normalized.observations[0]?.kind, 'message.user')
    assert.deepEqual(await read({ filePath: path, nativeSessionId: 'wrong' }, ctx),
      { state: 'drifted', reason: 'native-session-identity-changed' })
    assert.equal(first.nextCursor.fileIdentity,`${(await stat(path)).dev}:${(await stat(path)).ino}`)
    // Even when the new file reproduces the exact content/session metadata,
    // a cursor anchored to the prior inode cannot silently cross the rename.
    const replacement=join(root,'replacement.jsonl')
    await writeFile(replacement,[header,message(1),message(2)].join('\n')+'\n')
    await rename(replacement,path)
    assert.deepEqual(await read({filePath:path,nativeSessionId:'pi-page',cursor:first.nextCursor},ctx),
      {state:'drifted',reason:'native-file-identity-changed'})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi oversized locator scans resumable physical windows without skipping or inventing turns',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-oversize-locate-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'oversize-session'})
  const small=Array.from({length:9},(_,i)=>JSON.stringify({
    type:'message',id:'u-'+i,message:{role:'user',content:'small-'+i},
  }))
  const giant=JSON.stringify({
    type:'message',id:'large-user',
    message:{role:'user',content:'中国🚀'.repeat(450000)},
  })
  const ctx:SourceRawRecoveryContext={
    host:{id:'host',name:'host',platform:process.platform,arch:process.arch,
      createdAt:'2026-11-01T00:00:00Z',lastSeenAt:'2026-11-01T00:00:00Z'},
    installation:{id:'pi-oversize',hostId:'host',productId:'pi',dataRoot:root,
      firstSeenAt:'2026-11-01T00:00:00Z',lastSeenAt:'2026-11-01T00:00:00Z'},
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},async set(){throw Error('write prohibited')},
      async clear(){throw Error('delete prohibited')}},
  }
  try{
    await writeFile(file,[header,...small,giant].join('\n')+'\n')
    const search=piSourceDefinition.locateOversizedRecord!
    const first=await search({filePath:file,nativeSessionId:'oversize-session',limit:8},ctx)
    assert.equal(first.state,'more')
    if(first.state!=='more')return
    assert.ok(first.nextCursor.offset>0)
    const second=await search({filePath:file,nativeSessionId:'oversize-session',
      cursor:first.nextCursor,limit:8},ctx)
    assert.equal(second.state,'found')
    if(second.state!=='found')return
    assert.equal(second.cursor.offset,Buffer.byteLength([header,...small].join('\n')+'\n'))
    assert.equal(second.cursor.recordFingerprint,hash(giant))
    assert.equal(second.recordSha256,hash(giant))
    assert.equal(second.nativeEventId,'large-user')
    assert.equal(second.hasText,true)
    const firstPage=await piSourceDefinition.readNativeTextFragments!({
      filePath:file,nativeSessionId:'oversize-session',cursor:second.cursor,
      expectedSha256:second.recordSha256,limit:2,
    },ctx)
    assert.equal(firstPage.state,'available')
    if(firstPage.state==='available'){
      assert.deepEqual(firstPage.record.fragments.map(x=>x.ordinal),[0,1])
      assert.equal(firstPage.record.nextFragmentOffset,2)
    }
    assert.deepEqual(await search({filePath:file,nativeSessionId:'wrong'},ctx),
      {state:'drifted',reason:'native-session-identity-changed'})
    const extra=await search({filePath:file,nativeSessionId:'oversize-session',
      cursor:{...second.cursor,offset:second.cursor.offset+1}},ctx)
    assert.equal(extra.state,'drifted')
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Pi exact native tool link scans following records with SHA-bound call evidence and resumable cursor',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-tool-link-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'tool-link-native'})
  const nativeId='call-authentic-1'
  const call=JSON.stringify({type:'message',id:'assistant-large',
    message:{role:'assistant',content:[
      {type:'toolCall',id:nativeId,name:'read',
        arguments:{note:'x'.repeat(2_200_000)}},
    ]},
  })
  const noise=(id:number)=>JSON.stringify({type:'message',id:'other-'+id,
    message:{role:'assistant',content:'unrelated'}})
  const result=JSON.stringify({type:'message',id:'result-native',
    message:{role:'toolResult',toolCallId:nativeId,
      content:[{type:'text',text:'verified return'}],details:{status:200}},
  })
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:'2026-11-01T00:00:00Z',lastSeenAt:'2026-11-01T00:00:00Z'}
  const ctx:SourceRawRecoveryContext={host,
    installation:{id:'pi-link',hostId:'host',productId:'pi',dataRoot:root,
      firstSeenAt:'2026-11-01T00:00:00Z',lastSeenAt:'2026-11-01T00:00:00Z'},
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},
      async set(){throw Error('read-only')},async clear(){throw Error('read-only')}},
  }
  try{
    await writeFile(file,[header,call,noise(1),noise(2),result].join('\n')+'\n')
    const located=await piSourceDefinition.locateOversizedRecord!({
      filePath:file,nativeSessionId:'tool-link-native',limit:4,
    },ctx)
    assert.equal(located.state,'found')
    if(located.state!=='found')return
    const start=await piSourceDefinition.readNativeTextFragments!({
      filePath:file,nativeSessionId:'tool-link-native',
      cursor:located.cursor,expectedSha256:located.recordSha256,
      fragmentOffset:0,limit:1,
    },ctx)
    assert.equal(start.state,'available')
    if(start.state!=='available')return
    const callKey=start.record.fragments[0]?.callKey
    assert.equal(callKey,hash(nativeId))
    const query={filePath:file,nativeSessionId:'tool-link-native',
      cursor:located.cursor,expectedSha256:located.recordSha256,
      fragmentOrdinal:0,callKey:callKey!,limit:2}
    const find=piSourceDefinition.findNativeToolResult!
    const first=await find(query,ctx)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.equal(first.match,undefined)
    assert.equal(first.scannedRecords,2)
    assert.ok(first.nextCursor)
    const second=await find({...query,scanCursor:first.nextCursor},ctx)
    assert.equal(second.state,'available')
    if(second.state!=='available')return
    assert.equal(second.scannedRecords,1)
    assert.equal(second.match?.recordSha256,hash(result))
    assert.ok(second.match?.cursor.recordFingerprint)
    const verified=await piSourceDefinition.readNativeTextFragments!({
      filePath:file,nativeSessionId:'tool-link-native',
      cursor:second.match!.cursor,expectedSha256:second.match!.recordSha256,
      limit:4,
    },ctx)
    assert.equal(verified.state,'available')
    if(verified.state==='available'){
      assert.equal(verified.record.role,'toolResult')
      assert.ok(verified.record.fragments.every(x=>x.callKey===callKey))
    }
    const wrong=await find({...query,callKey:hash('unknown')},ctx)
    assert.deepEqual(wrong,{state:'unsupported',
      reason:'native-tool-call-evidence-mismatch'})
    const outside=await find({...query,
      scanCursor:{...first.nextCursor!,offset:located.cursor.offset}},ctx)
    assert.deepEqual(outside,{state:'unsupported',
      reason:'native-tool-link-cursor-invalid'})
    assert.deepEqual(await find({...query,nativeSessionId:'wrong'},ctx),{
      state:'drifted',reason:'native-session-identity-changed'})
    assert.equal(JSON.stringify(first).includes('x'.repeat(128)),false)
    assert.equal(JSON.stringify(second).includes('verified return'),false)
  }finally{await rm(root,{recursive:true,force:true})}
})
