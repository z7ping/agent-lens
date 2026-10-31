import assert from 'node:assert/strict'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectNativeSessionRecordSpan, readNativeSessionWindow } from './native-session-window'

test('native window paginates without scanning history or persisting checkpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-native-window-'))
  const path = join(root, 'session.jsonl')
  try {
    const body = [1,2,3,4].map(id => JSON.stringify({ id, content: '中文' })).join('\r\n') + '\r\n'
    await writeFile(path, body)
    const args = { path, allowedRoots: [root] }
    const first = await readNativeSessionWindow({ ...args, limit: 2 })
    assert.equal(first.state, 'available')
    if (first.state !== 'available') return
    assert.deepEqual(first.lines.map(x => x.entry.id), [1,2])
    assert.deepEqual(first.lines.map(x => x.sequence), [1,2])
    assert.equal(first.hasMore, true)
    const second = await readNativeSessionWindow({ ...args, cursor: first.nextCursor, limit: 2 })
    assert.equal(second.state, 'available')
    if (second.state !== 'available') return
    assert.deepEqual(second.lines.map(x => x.entry.id), [3,4])
    assert.equal(second.nextCursor.sequence, 4)
    assert.equal(second.hasMore, false)
    assert.equal(second.pendingTail, false)

    await appendFile(path, JSON.stringify({id:5}) + '\n')
    const third = await readNativeSessionWindow({ ...args, cursor: second.nextCursor, limit: 2 })
    assert.equal(third.state, 'available')
    if (third.state !== 'available') return
    assert.deepEqual(third.lines.map(x => x.entry.id), [5])
    assert.equal(third.nextCursor.sequence, 5)
  } finally {
    await rm(root,{recursive:true,force:true})
  }
})

test('native window never consumes an unfinished tail, and safely resumes after append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-native-tail-'))
  const path = join(root,'log.jsonl')
  try {
    await writeFile(path, '{"id":1}\n{"id":2')
    const first = await readNativeSessionWindow({path,allowedRoots:[root]})
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.deepEqual(first.lines.map(x=>x.entry.id),[1])
    assert.equal(first.pendingTail,true)
    assert.equal(first.nextCursor.sequence,1)
    await appendFile(path,'}\n')
    const next=await readNativeSessionWindow({path,allowedRoots:[root],cursor:first.nextCursor})
    assert.equal(next.state,'available')
    if(next.state!=='available')return
    assert.deepEqual(next.lines.map(x=>x.entry.id),[2])
    assert.equal(next.nextCursor.sequence,2)
  } finally {await rm(root,{recursive:true,force:true})}
})

test('native window rejects traversal, invalid cursor, truncation and non-JSONL records',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-guard-'))
  const allowed=join(root,'allowed')
  const outside=join(root,'outside.jsonl')
  const path=join(allowed,'record.jsonl')
  try{
    await mkdir(allowed)
    await writeFile(outside,'{"a":1}\n')
    await writeFile(path,'{"a":1}\n{"a":2}\n')
    assert.deepEqual(await readNativeSessionWindow({path:outside,allowedRoots:[allowed]}),{state:'unsupported',reason:'source-path-not-authorized'})
    const good=await readNativeSessionWindow({path,allowedRoots:[allowed],limit:1})
    assert.equal(good.state,'available')
    if(good.state!=='available')return
    assert.deepEqual(await readNativeSessionWindow({path,allowedRoots:[allowed],cursor:{...good.nextCursor,fileIdentity:'other'}}),{state:'drifted',reason:'native-file-identity-changed'})
    assert.deepEqual(await readNativeSessionWindow({path,allowedRoots:[allowed],cursor:{...good.nextCursor,offset:3}}),{state:'drifted',reason:'native-cursor-not-line-aligned'})
    await writeFile(path,'{"a":1}\n')
    assert.deepEqual(await readNativeSessionWindow({path,allowedRoots:[allowed],cursor:{...good.nextCursor,offset:100}}),{state:'drifted',reason:'native-file-shrank'})
    await writeFile(path,'42\n')
    assert.deepEqual(await readNativeSessionWindow({path,allowedRoots:[allowed]}),{state:'unsupported',reason:'native-record-not-object'})
    await writeFile(path,'{malformed}\n')
    assert.deepEqual(await readNativeSessionWindow({path,allowedRoots:[allowed]}),{state:'unsupported',reason:'native-invalid-json'})
  }finally{await rm(root,{recursive:true,force:true})}
})

test('native window enforces record size and cancellation limits',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-limit-'))
  const path=join(root,'record.jsonl')
  try{
    await writeFile(path,JSON.stringify({data:'a'.repeat(2*1024*1024)})+'\n')
    assert.deepEqual(await readNativeSessionWindow({path,allowedRoots:[root]}),{state:'unsupported',reason:'native-record-too-large'})
    const controller=new AbortController()
    controller.abort()
    await assert.rejects(readNativeSessionWindow({path,allowedRoots:[root],signal:controller.signal}))
    assert.deepEqual(await readNativeSessionWindow({path,allowedRoots:[root],limit:65}),{state:'unsupported',reason:'invalid-window-reference'})
  }finally{await rm(root,{recursive:true,force:true})}
})


test('native JSONL cursor detects same-inode overwrite at its previous line boundary',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-cursor-hash-'))
  const path=join(root,'session.jsonl')
  try{
    const initial=JSON.stringify({id:1})+'\n'+JSON.stringify({id:2})+'\n'
    await writeFile(path,initial)
    const args={path,allowedRoots:[root]}
    const first=await readNativeSessionWindow({...args,limit:1})
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.match(first.nextCursor.boundaryHash??'',/^[0-9a-f]{64}$/)
    assert.match(first.lines[0]?.boundaryHash??'',/^[0-9a-f]{64}$/)
    const second=await readNativeSessionWindow({...args,cursor:first.nextCursor,limit:1})
    assert.equal(second.state,'available')
    // Replace one source record with the SAME byte length and no inode change.
    // A simple dev:ino / line-alignment check would incorrectly accept it.
    await writeFile(path,JSON.stringify({id:9})+'\n'+JSON.stringify({id:2})+'\n')
    const drifted=await readNativeSessionWindow({...args,cursor:first.nextCursor,limit:1})
    assert.deepEqual(drifted,{state:'drifted',reason:'native-cursor-boundary-changed'})
    const invalid=await readNativeSessionWindow({...args,cursor:{
      ...first.nextCursor,boundaryHash:'not-a-sha256',
    }})
    assert.deepEqual(invalid,{state:'unsupported',reason:'invalid-window-reference'})
    // Legacy 3-field cursors remain readable, but every NEW returned cursor
    // carries the fingerprint and can be verified on the next page.
    const legacy=await readNativeSessionWindow({...args,cursor:{
      offset:first.nextCursor.offset,sequence:first.nextCursor.sequence,
      fileIdentity:first.nextCursor.fileIdentity,
    }})
    assert.equal(legacy.state,'available')
    if(legacy.state==='available')assert.match(legacy.nextCursor.boundaryHash??'',/^[0-9a-f]{64}$/)
  }finally{await rm(root,{recursive:true,force:true})}
})



test('native window assembles multi-chunk UTF-8 records once and preserves exact cursors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-native-long-line-'))
  const path = join(root, 'long.jsonl')
  try {
    // CR is the final byte of the first 64KiB chunk; the newline comes next.
    const firstText = JSON.stringify({ id: 1, text: 'a'.repeat(65_535 - JSON.stringify({ id: 1, text: '' }).length) })
    assert.equal(Buffer.byteLength(firstText), 65_535)
    const secondText = JSON.stringify({ id: 2, text: '中'.repeat(100_000) })
    const thirdText = JSON.stringify({ id: 3, text: 'end' })
    await writeFile(path, firstText + '\r\n' + secondText + '\n' + thirdText + '\n')
    const args = { path, allowedRoots: [root], limit: 1 }
    const first = await readNativeSessionWindow(args)
    assert.equal(first.state, 'available')
    if (first.state !== 'available') return
    assert.equal(first.lines[0]?.entry.id, 1)
    assert.equal(first.nextCursor.offset, Buffer.byteLength(firstText) + 2)
    assert.match(first.nextCursor.boundaryHash ?? '', /^[a-f0-9]{64}$/)
    const second = await readNativeSessionWindow({ ...args, cursor: first.nextCursor })
    assert.equal(second.state, 'available')
    if (second.state !== 'available') return
    assert.equal(second.lines[0]?.entry.id, 2)
    assert.equal((second.lines[0]?.entry.text as string).length, 100_000)
    assert.equal(second.lines[0]?.offset, first.nextCursor.offset)
    assert.equal(second.nextCursor.offset, first.nextCursor.offset + Buffer.byteLength(secondText) + 1)
    const third = await readNativeSessionWindow({ ...args, cursor: second.nextCursor })
    assert.equal(third.state, 'available')
    if (third.state !== 'available') return
    assert.equal(third.lines[0]?.entry.id, 3)
    assert.equal(third.nextCursor.sequence, 3)
    assert.equal(third.hasMore, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native window resumes a multi-chunk unfinished tail after append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-native-long-tail-'))
  const path = join(root, 'tail.jsonl')
  try {
    const prefix = JSON.stringify({ id: 1 }) + '\n'
    const large = JSON.stringify({ id: 2, text: '甲'.repeat(95_000) })
    const cut = large.length - 3
    await writeFile(path, prefix + large.slice(0, cut))
    const first = await readNativeSessionWindow({ path, allowedRoots: [root] })
    assert.equal(first.state, 'available')
    if (first.state !== 'available') return
    assert.equal(first.pendingTail, true)
    assert.equal(first.lines.length, 1)
    assert.equal(first.nextCursor.offset, Buffer.byteLength(prefix))
    await appendFile(path, large.slice(cut) + '\n')
    const continued = await readNativeSessionWindow({
      path, allowedRoots: [root], cursor: first.nextCursor,
    })
    assert.equal(continued.state, 'available')
    if (continued.state !== 'available') return
    assert.equal(continued.lines.length, 1)
    assert.equal(continued.lines[0]?.entry.id, 2)
    assert.equal(continued.hasMore, false)
    assert.equal(continued.pendingTail, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('oversized JSONL span is hashed by bounded byte scan without parsing or consuming its SourceRecord',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-oversize-span-'))
  const path=join(root,'record.jsonl')
  try{
    const record=JSON.stringify({type:'message',id:'large-user',message:{
      role:'user',content:'x'.repeat(2*1024*1024+7),
    }})
    await writeFile(path,record+'\n'+JSON.stringify({id:'next'})+'\n')
    const result=await inspectNativeSessionRecordSpan({path,allowedRoots:[root]})
    assert.equal(result.state,'available')
    if(result.state!=='available')return
    assert.equal(result.span.offset,0)
    assert.equal(result.span.rawByteLength,Buffer.byteLength(record))
    assert.equal(result.span.nextOffset,Buffer.byteLength(record)+1)
    assert.equal(result.span.sha256,createHash('sha256').update(record).digest('hex'))
    assert.equal(result.span.oversized,true)
    assert.match(result.span.boundaryHash,/^[a-f0-9]{64}$/)
    assert.match(result.span.endBoundaryHash,/^[a-f0-9]{64}$/)
    assert.deepEqual(await readNativeSessionWindow({path,allowedRoots:[root]}),
      {state:'unsupported',reason:'native-record-too-large'},
      'inspecting an oversized span must not silently skip or normalize it')
    assert.deepEqual(await inspectNativeSessionRecordSpan({path,allowedRoots:[root],
      expectedSha256:'0'.repeat(64)}),
    {state:'drifted',reason:'native-record-hash-changed'})
  }finally{await rm(root,{recursive:true,force:true})}
})

test('span scanner respects incomplete tails, authorized roots and cursor drift',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-span-guard-'))
  const path=join(root,'record.jsonl')
  const excluded=join(root,'excluded')
  try{
    await mkdir(excluded)
    await writeFile(path,'{"id":"first"}')
    assert.deepEqual(await inspectNativeSessionRecordSpan({path,allowedRoots:[root]}),
      {state:'pending',reason:'native-record-pending-tail'})
    assert.deepEqual(await inspectNativeSessionRecordSpan({path,allowedRoots:[excluded]}),
      {state:'unsupported',reason:'source-path-not-authorized'})
    await appendFile(path,'\n{"id":"second"}\n')
    const first=await inspectNativeSessionRecordSpan({path,allowedRoots:[root]})
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    const cursor={offset:first.span.nextOffset,sequence:1,
      fileIdentity:first.span.fileIdentity,boundaryHash:first.span.endBoundaryHash}
    const second=await inspectNativeSessionRecordSpan({path,allowedRoots:[root],cursor})
    assert.equal(second.state,'available')
    if(second.state==='available')assert.equal(second.span.rawByteLength,15)
    await writeFile(path,'{"id":"other"}\n{"id":"second"}\n')
    assert.deepEqual(await inspectNativeSessionRecordSpan({path,allowedRoots:[root],cursor}),
      {state:'drifted',reason:'native-cursor-boundary-changed'})
    const controller=new AbortController()
    controller.abort()
    await assert.rejects(inspectNativeSessionRecordSpan({path,allowedRoots:[root],
      signal:controller.signal}))
  }finally{await rm(root,{recursive:true,force:true})}
})
