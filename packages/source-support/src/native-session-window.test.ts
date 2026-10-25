import assert from 'node:assert/strict'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readNativeSessionWindow } from './native-session-window'

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
