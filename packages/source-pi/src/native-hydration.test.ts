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

test('Pi links oversized zero-argument native tool blocks by original content[] identity',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-empty-call-'))
  const path=join(root,'session.jsonl')
  const id='native-zero-arguments'
  const call=JSON.stringify({type:'message',id:'assistant-big',
    message:{role:'assistant',content:[
      {type:'toolCall',id,name:'list_files',arguments:{}},
      {type:'image',mimeType:'image/png',data:'A'.repeat(2_250_000)},
    ]}})
  const response=JSON.stringify({type:'message',id:'result-1',
    message:{role:'toolResult',toolCallId:id,content:[{type:'text',text:'ok'}]}})
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:'2026-11-01T00:00:00Z',lastSeenAt:'2026-11-01T00:00:00Z'}
  const ctx:SourceRawRecoveryContext={host,
    installation:{id:'pi-zero-arg',hostId:'host',productId:'pi',dataRoot:root,
      firstSeenAt:'2026-11-01T00:00:00Z',lastSeenAt:'2026-11-01T00:00:00Z'},
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},
      async set(){throw Error('read-only')},async clear(){throw Error('read-only')}},
  }
  try{
    await writeFile(path,[
      JSON.stringify({type:'session',id:'zero-arg-session'}),call,response,
    ].join('\n')+'\n')
    const located=await piSourceDefinition.locateOversizedRecord!({
      filePath:path,nativeSessionId:'zero-arg-session',limit:3,
    },ctx)
    assert.equal(located.state,'found')
    if(located.state!=='found')return
    const first=await piSourceDefinition.readNativeTextFragments!({
      filePath:path,nativeSessionId:'zero-arg-session',
      cursor:located.cursor,expectedSha256:located.recordSha256,limit:1,
    },ctx)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.equal(first.record.totalTextFragments,0)
    const block=first.record.contentBlocks?.find(x=>x.contentIndex===0)
    assert.equal(block?.kind,'tool-call')
    assert.equal(block?.callKey,hash(id))
    const query={filePath:path,nativeSessionId:'zero-arg-session',
      cursor:located.cursor,expectedSha256:located.recordSha256,
      contentIndex:0,callKey:block!.callKey!,limit:3}
    const find=piSourceDefinition.findNativeToolResult!
    const linked=await find(query,ctx)
    assert.equal(linked.state,'available')
    if(linked.state==='available'){
      assert.equal(linked.scannedRecords,1)
      assert.equal(linked.match?.recordSha256,hash(response))
    }
    const wrong=await find({...query,contentIndex:1},ctx)
    assert.deepEqual(wrong,{state:'unsupported',
      reason:'native-tool-call-evidence-mismatch'})
    assert.deepEqual(await find({...query,fragmentOrdinal:0},ctx),{
      state:'unsupported',reason:'invalid-native-tool-link-query'})
    assert.deepEqual(await find({...query,contentIndex:undefined},ctx),{
      state:'unsupported',reason:'invalid-native-tool-link-query'})
  }finally{await rm(root,{recursive:true,force:true})}
})

test('oversized Pi image user message joins canonical native TaskSurface with complete text and lazy image evidence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-pi-large-user-image-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'large-image-turn',cwd:'/project'})
  const timestamp='2026-11-01T11:22:33.000Z'
  const giant=JSON.stringify({type:'message',id:'native-image-user',timestamp,
    parentId:'parent-user',message:{role:'user',content:[
      {type:'text',text:'First line'},
      {type:'image',mimeType:'image/png',data:'A'.repeat(2_300_000)},
      {type:'text',text:'Last line'},
    ]}})
  const next=JSON.stringify({type:'message',id:'assistant-reply',message:{
    role:'assistant',content:[{type:'text',text:'Acknowledged'}],
  }})
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:timestamp,lastSeenAt:timestamp}
  const installation={id:'pi-large-image',hostId:'host',productId:'pi',dataRoot:root,
    firstSeenAt:timestamp,lastSeenAt:timestamp}
  const ctx:SourceRawRecoveryContext={host,installation,
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},
      async set(){throw Error('read-only')},async clear(){throw Error('read-only')}},
  }
  try{
    await writeFile(file,[header,giant,next].join('\n')+'\n')
    assert.ok(Buffer.byteLength(giant)>2*1024*1024)
    const read=piSourceDefinition.readNativeSessionPage!
    const first=await read({filePath:file,nativeSessionId:'large-image-turn',limit:1},ctx)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.equal(first.records.length,1)
    const recovered=await read({filePath:file,nativeSessionId:'large-image-turn',
      cursor:first.nextCursor,limit:1},ctx)
    assert.equal(recovered.state,'available')
    if(recovered.state!=='available')return
    assert.equal(recovered.records.length,1)
    const record=recovered.records[0]!
    assert.equal(record.nativeId,'native-image-user')
    assert.equal(record.sourceSequence,2000)
    assert.equal(record.fingerprint,hash(giant))
    assert.equal(record.occurredAt,timestamp)
    assert.equal(recovered.recordCursors?.[0]?.offset,first.nextCursor.offset)
    assert.equal(recovered.recordCursors?.[0]?.recordFingerprint,hash(giant))
    assert.equal(recovered.nextCursor.sequence,2)
    assert.equal(recovered.hasMore,true)
    assert.ok(JSON.stringify(record.payload).length<2048,
      'source-normalized image metadata must not retain the giant base64')
    const normalized=await piSourceDefinition.normalize(record,{host,installation})
    const message=normalized.observations.find(x=>x.kind==='message.user')
    assert.ok(message)
    const payload=message?.payload as {text?:string;attachments?:Array<{
      type:string;mimeType:string;data?:string}>}
    assert.equal(payload.text,'First line\n\nLast line')
    assert.deepEqual(payload.attachments,[{type:'image',mimeType:'image/png'}])
    assert.ok(normalized.evidenceCandidates.some(x=>x.sourceRecordId===record.id))
    const following=await read({filePath:file,nativeSessionId:'large-image-turn',
      cursor:recovered.nextCursor,limit:1},ctx)
    assert.equal(following.state,'available')
    if(following.state==='available')
      assert.equal(following.records[0]?.nativeId,'assistant-reply')
    // An actual overlong user text is NOT promoted to a fabricated complete
    // message; the original record stays eligible for fragment-only fallback.
    const longText=JSON.stringify({type:'message',id:'too-much-text',
      message:{role:'user',content:'T'.repeat(2_300_000)}})
    await writeFile(file,[header,longText].join('\n')+'\n')
    const ret=await read({filePath:file,nativeSessionId:'large-image-turn',
      cursor:{offset:Buffer.byteLength(header+'\n'),sequence:1,
        fileIdentity:`${(await stat(file)).dev}:${(await stat(file)).ino}`},
      limit:1},ctx)
    assert.deepEqual(ret,{state:'unsupported',
      reason:'native-record-too-large'})
    const extra=JSON.stringify({type:'message',id:'extra-fields',
      message:{role:'user',content:[
        {type:'text',text:'verified text'},
        {type:'image',mimeType:'image/png',data:'A'.repeat(2_300_000)},
      ],toolContext:{unparsed:'must-not-disappear'}},
    })
    await writeFile(file,[header,extra].join('\n')+'\n')
    const notComplete=await read({filePath:file,nativeSessionId:'large-image-turn',
      cursor:{offset:Buffer.byteLength(header+'\n'),sequence:1,
        fileIdentity:`${(await stat(file)).dev}:${(await stat(file)).ino}`},
      limit:1},ctx)
    assert.deepEqual(notComplete,{state:'unsupported',
      reason:'native-record-too-large'},
      'unrecognized source semantics cannot silently disappear from formal Review')
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Pi oversized user image with invalid native base64 remains unsupported',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-pi-invalid-large-image-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'invalid-large-image'})
  const giant=JSON.stringify({type:'message',id:'bad-image',message:{
    role:'user',content:[{type:'image',mimeType:'image/png',
      data:'A'.repeat(2_300_000-1)+'$'}],
  }})
  const timestamp='2026-11-01T00:00:00Z'
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:timestamp,lastSeenAt:timestamp}
  const installation={id:'pi-invalid-image',hostId:'host',productId:'pi',dataRoot:root,
    firstSeenAt:timestamp,lastSeenAt:timestamp}
  const ctx:SourceRawRecoveryContext={host,installation,
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},
      async set(){throw Error('read-only')},async clear(){throw Error('read-only')}},
  }
  try{
    await writeFile(file,[header,giant].join('\n')+'\n')
    const first=await piSourceDefinition.readNativeSessionPage!({
      filePath:file,nativeSessionId:'invalid-large-image',limit:1},ctx)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    const result=await piSourceDefinition.readNativeSessionPage!({
      filePath:file,nativeSessionId:'invalid-large-image',
      cursor:first.nextCursor,limit:1},ctx)
    assert.deepEqual(result,{state:'unsupported',
      reason:'native-record-too-large'})
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Pi oversized assistant text, thinking, empty tool call and image preserves native fact order',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-pi-large-assistant-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'large-assistant',cwd:'/project'})
  const callId='original-large-assistant-call'
  const message=JSON.stringify({
    type:'message',id:'assistant-giant',timestamp:'2026-11-01T12:00:00.000Z',
    parentId:'user-1',message:{role:'assistant',
      model:'test-model',provider:'test-provider',stopReason:'toolUse',
      content:[
        {type:'text',text:'Visible preface'},
        {type:'thinking',thinking:'Original thinking'},
        {type:'toolCall',id:callId,name:'read',arguments:{}},
        {type:'image',mimeType:'image/png',data:'A'.repeat(2_300_000)},
        {type:'text',text:'Visible conclusion'},
      ],
    },
  })
  const result=JSON.stringify({type:'message',id:'returned-tool',message:{
    role:'toolResult',toolCallId:callId,toolName:'read',
    content:[{type:'text',text:'result'}],
  }})
  const timestamp='2026-11-01T00:00:00Z'
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:timestamp,lastSeenAt:timestamp}
  const installation={id:'pi-giant-assistant',hostId:'host',productId:'pi',
    dataRoot:root,firstSeenAt:timestamp,lastSeenAt:timestamp}
  const ctx:SourceRawRecoveryContext={host,installation,
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},
      async set(){throw Error('read-only')},async clear(){throw Error('read-only')}},
  }
  try{
    await writeFile(file,[header,message,result].join('\n')+'\n')
    assert.ok(Buffer.byteLength(message)>2*1024*1024)
    const read=piSourceDefinition.readNativeSessionPage!
    const initial=await read({filePath:file,nativeSessionId:'large-assistant',limit:1},ctx)
    assert.equal(initial.state,'available')
    if(initial.state!=='available')return
    const oversized=await read({filePath:file,nativeSessionId:'large-assistant',
      cursor:initial.nextCursor,limit:1},ctx)
    assert.equal(oversized.state,'available')
    if(oversized.state!=='available')return
    assert.equal(oversized.records.length,1)
    const record=oversized.records[0]!
    assert.equal(record.fingerprint,hash(message))
    assert.equal(record.nativeId,'assistant-giant')
    assert.ok(JSON.stringify(record.payload).length<4096)
    assert.ok(!JSON.stringify(record.payload).includes('A'.repeat(256)))
    const facts=await piSourceDefinition.normalize(record,{host,installation})
    const kinds=facts.observations.map(item=>item.kind)
    assert.deepEqual(kinds.slice(0,5),[
      'message.assistant','message.reasoning','tool.call',
      'message.assistant','message.assistant',
    ])
    const call=facts.observations.find(item=>item.kind==='tool.call')
    assert.equal(call?.nativeCallId,callId)
    assert.equal((call?.payload as {nativeToolName:string}).nativeToolName,'read')
    assert.deepEqual((call?.payload as {input:unknown}).input,{})
    const image=facts.observations.find(item=>
      item.kind==='message.assistant'
      &&(item.payload as {attachments?:unknown}).attachments)
    assert.ok(image)
    assert.deepEqual((image?.payload as {attachments:unknown}).attachments,
      [{type:'image',mimeType:'image/png'}])
    assert.ok(facts.evidenceCandidates.every(item=>item.sourceRecordId===record.id))
    const after=await read({filePath:file,nativeSessionId:'large-assistant',
      cursor:oversized.nextCursor,limit:1},ctx)
    assert.equal(after.state,'available')
    if(after.state==='available'){
      const next=await piSourceDefinition.normalize(after.records[0]!,{host,installation})
      assert.equal(next.observations.find(item=>item.kind==='tool.result')?.nativeCallId,callId)
    }
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Pi oversized assistant refuses nonempty arguments, duplicate call IDs and unparsed fields',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-pi-large-assistant-reject-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'large-assistant-reject'})
  const timestamp='2026-11-01T00:00:00Z'
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:timestamp,lastSeenAt:timestamp}
  const installation={id:'pi-reject-assistant',hostId:'host',productId:'pi',
    dataRoot:root,firstSeenAt:timestamp,lastSeenAt:timestamp}
  const ctx:SourceRawRecoveryContext={host,installation,
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},
      async set(){throw Error('read-only')},async clear(){throw Error('read-only')}},
  }
  try{
    const variants=[
      [{type:'toolCall',id:'one',name:'exec',arguments:{script:'danger'}}],
      [{type:'toolCall',id:'one',name:'exec',arguments:{}},
        {type:'toolCall',id:'one',name:'exec',arguments:{}}],
      [{type:'text',text:'preface',otherHiddenFact:'unparsed'}],
      [{type:'toolCall',id:'one',name:'exec',arguments:'not-an-object'}],
    ]
    for(const [index,blocks] of variants.entries()){
      const oversized=JSON.stringify({type:'message',id:'assistant-'+index,
        message:{role:'assistant',content:[
          ...blocks,{type:'image',mimeType:'image/png',data:'A'.repeat(2_250_000)},
        ]}})
      await writeFile(file,[header,oversized].join('\n')+'\n')
      const first=await piSourceDefinition.readNativeSessionPage!({
        filePath:file,nativeSessionId:'large-assistant-reject',limit:1,
      },ctx)
      assert.equal(first.state,'available')
      if(first.state!=='available')continue
      const second=await piSourceDefinition.readNativeSessionPage!({
        filePath:file,nativeSessionId:'large-assistant-reject',
        cursor:first.nextCursor,limit:1,
      },ctx)
      assert.deepEqual(second,{state:'unsupported',reason:'native-record-too-large'},
        'unsupported oversized assistant variant '+index+' must remain fragment-only')
    }
  }finally{await rm(root,{recursive:true,force:true})}
})

test('giant scalar Pi user and assistant bodies become verified lazy native Review facts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-large-scalar-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'large-scalar'})
  const originalText='原文🚀'.repeat(400_000)
  const user=JSON.stringify({type:'message',id:'giant-user',message:{
    role:'user',content:originalText,
  }})
  const assistant=JSON.stringify({type:'message',id:'giant-assistant',message:{
    role:'assistant',content:originalText,
    model:'test-model',provider:'test',
  }})
  const ts='2026-11-01T00:00:00Z'
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:ts,lastSeenAt:ts}
  const installation={id:'large-scalar',hostId:'host',productId:'pi',
    dataRoot:root,firstSeenAt:ts,lastSeenAt:ts}
  const ctx:SourceRawRecoveryContext={host,installation,
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},async set(){throw Error('read-only')},
      async clear(){throw Error('read-only')}},
  }
  try{
    await writeFile(file,[header,user,assistant].join('\n')+'\n')
    let cursor:Parameters<NonNullable<typeof piSourceDefinition.readNativeSessionPage>>[0]['cursor']|undefined
    const read=piSourceDefinition.readNativeSessionPage!
    const first=await read({filePath:file,nativeSessionId:'large-scalar',limit:1},ctx)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    cursor=first.nextCursor
    for(const [id,physical] of [['giant-user',user],['giant-assistant',assistant]]){
      const result=await read({filePath:file,nativeSessionId:'large-scalar',
        cursor,limit:1},ctx)
      assert.equal(result.state,'available')
      if(result.state!=='available')break
      assert.equal(result.records.length,1)
      const record=result.records[0]!
      assert.equal(record.nativeId,id)
      assert.equal(record.fingerprint,hash(physical))
      assert.ok(JSON.stringify(record.payload).length<2048)
      assert.ok(!JSON.stringify(record.payload).includes('原文🚀'))
      const normalized=await piSourceDefinition.normalize(record,{host,installation})
      const message=normalized.observations.find(item=>
        item.kind==='message.user'||item.kind==='message.assistant')
      assert.ok(message)
      const ref=(message?.payload as {nativeLazyText?:{
        recordSha256:string;totalTextFragments:number}}).nativeLazyText
      assert.ok(ref)
      assert.ok(ref.totalTextFragments>16)
      assert.ok(/^[0-9a-f]{64}$/.test(ref.recordSha256))
      cursor=result.nextCursor
    }
  }finally{await rm(root,{recursive:true,force:true})}
})

test('giant scalar Pi record with unknown semantic field never promotes a fake complete turn',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-scalar-unknown-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'unknown-scalar'})
  const giant=JSON.stringify({type:'message',id:'user-unknown',message:{
    role:'user',content:'x'.repeat(2_200_000),
    additionalUnparsedField:'evidence cannot disappear',
  }})
  const ts='2026-11-01T00:00:00Z'
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:ts,lastSeenAt:ts}
  const installation={id:'unknown-scalar',hostId:'host',productId:'pi',
    dataRoot:root,firstSeenAt:ts,lastSeenAt:ts}
  const ctx:SourceRawRecoveryContext={host,installation,
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},async set(){throw Error('read-only')},
      async clear(){throw Error('read-only')}},
  }
  try{
    await writeFile(file,[header,giant].join('\n')+'\n')
    const read=piSourceDefinition.readNativeSessionPage!
    const first=await read({filePath:file,nativeSessionId:'unknown-scalar',limit:1},ctx)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.deepEqual(await read({filePath:file,nativeSessionId:'unknown-scalar',
      cursor:first.nextCursor,limit:1},ctx),{
      state:'unsupported',reason:'native-record-too-large',
    })
  }finally{await rm(root,{recursive:true,force:true})}
})

test('giant Pi toolResult preserves explicit success/failure, original call ID and lazy output',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-tool-result-lazy-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'giant-tool-result'})
  const output='完成🚀'.repeat(410_000)
  const ts='2026-11-01T00:00:00Z'
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:ts,lastSeenAt:ts}
  const installation={id:'tool-result-inst',hostId:'host',productId:'pi',
    dataRoot:root,firstSeenAt:ts,lastSeenAt:ts}
  const ctx:SourceRawRecoveryContext={host,installation,
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},async set(){throw Error('read-only')},
      async clear(){throw Error('read-only')}},
  }
  try{
    const read=piSourceDefinition.readNativeSessionPage!
    for(const isError of [true,false]){
      const raw=JSON.stringify({type:'message',id:'large-result',message:{
        role:'toolResult',toolCallId:'original-call',toolName:'read',
        isError,content:output,
      }})
      await writeFile(file,[header,raw].join('\n')+'\n')
      const first=await read({filePath:file,nativeSessionId:'giant-tool-result',
        limit:1},ctx)
      assert.equal(first.state,'available')
      if(first.state!=='available')continue
      const next=await read({filePath:file,nativeSessionId:'giant-tool-result',
        cursor:first.nextCursor,limit:1},ctx)
      assert.equal(next.state,'available')
      if(next.state!=='available')continue
      assert.equal(next.records[0]?.fingerprint,hash(raw))
      assert.ok(JSON.stringify(next.records[0]?.payload).length<2048)
      const normalized=await piSourceDefinition.normalize(next.records[0]!,{host,installation})
      const result=normalized.observations.find(x=>x.kind==='tool.result')
      assert.ok(result)
      assert.equal(result.nativeCallId,'original-call')
      const payload=result.payload as {success:boolean;output:string;
        nativeLazyText?:{recordSha256:string;totalTextFragments:number}}
      assert.equal(payload.success,!isError)
      assert.equal(payload.output,'')
      assert.ok(payload.nativeLazyText)
      assert.ok(payload.nativeLazyText.totalTextFragments>16)
      assert.ok(normalized.evidenceCandidates.every(x=>
        x.sourceRecordId===next.records[0]!.id))
    }
  }finally{await rm(root,{recursive:true,force:true})}
})

test('giant Pi toolResult with missing isError or unknown details remains fragment-only',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-tool-result-unknown-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'unknown-result'})
  const ts='2026-11-01T00:00:00Z'
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:ts,lastSeenAt:ts}
  const installation={id:'unknown-result-inst',hostId:'host',productId:'pi',
    dataRoot:root,firstSeenAt:ts,lastSeenAt:ts}
  const ctx:SourceRawRecoveryContext={host,installation,
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},async set(){throw Error('read-only')},
      async clear(){throw Error('read-only')}},
  }
  try{
    const read=piSourceDefinition.readNativeSessionPage!
    for(const body of [
      {role:'toolResult',toolCallId:'call',toolName:'read',
        content:'输出🚀'.repeat(410_000)},
      {role:'toolResult',toolCallId:'call',toolName:'read',
        isError:false,content:'输出🚀'.repeat(410_000),
        details:{status:'unverified'}},
    ]){
      await writeFile(file,[header,JSON.stringify({type:'message',id:'unknown-result',
        message:body})].join('\n')+'\n')
      const first=await read({filePath:file,nativeSessionId:'unknown-result',limit:1},ctx)
      assert.equal(first.state,'available')
      if(first.state!=='available')continue
      const next=await read({filePath:file,nativeSessionId:'unknown-result',
        cursor:first.nextCursor,limit:1},ctx)
      assert.deepEqual(next,{state:'unsupported',reason:'native-record-too-large'})
    }
  }finally{await rm(root,{recursive:true,force:true})}
})

test('a giant Pi assistant image record retains bounded nonempty tool arguments',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-pi-native-flat-args-'))
  const file=join(root,'session.jsonl')
  const header=JSON.stringify({type:'session',id:'native-flat-args'})
  const content=JSON.stringify({type:'message',id:'assistant-flat',message:{
    role:'assistant',content:[
      {type:'toolCall',id:'real-call',name:'read',
        arguments:{path:'README.md',count:2,recursive:true,optional:null}},
      {type:'image',mimeType:'image/png',data:'A'.repeat(2_300_000)},
    ],
  }})
  const ts='2026-11-01T00:00:00Z'
  const host={id:'host',name:'host',platform:process.platform,arch:process.arch,
    createdAt:ts,lastSeenAt:ts}
  const installation={id:'flat-args',hostId:'host',productId:'pi',
    dataRoot:root,firstSeenAt:ts,lastSeenAt:ts}
  const ctx:SourceRawRecoveryContext={host,installation,
    abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},async set(){throw Error('read-only')},
      async clear(){throw Error('read-only')}},
  }
  try{
    await writeFile(file,[header,content].join('\n')+'\n')
    const first=await piSourceDefinition.readNativeSessionPage!({
      filePath:file,nativeSessionId:'native-flat-args',limit:1},ctx)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    const oversized=await piSourceDefinition.readNativeSessionPage!({
      filePath:file,nativeSessionId:'native-flat-args',
      cursor:first.nextCursor,limit:1},ctx)
    assert.equal(oversized.state,'available')
    if(oversized.state!=='available')return
    assert.equal(oversized.records[0]?.fingerprint,hash(content))
    const normalized=await piSourceDefinition.normalize(oversized.records[0]!,{
      host,installation,
    })
    const call=normalized.observations.find(x=>x.kind==='tool.call')
    assert.equal(call?.nativeCallId,'real-call')
    assert.deepEqual((call?.payload as {input:unknown}).input,
      {path:'README.md',count:2,recursive:true,optional:null})
    assert.ok(JSON.stringify(oversized.records[0]?.payload).length<4096)
    assert.equal(JSON.stringify(oversized.records[0]?.payload).includes('A'.repeat(256)),false)
  }finally{await rm(root,{recursive:true,force:true})}
})
