import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readNativeJsonlTextFragments } from './native-jsonl-fragments'

test('a 3MiB Pi JSONL record is verified and paged without materializing the whole message',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-streamed-leaves-'))
  const path=join(root,'session.jsonl')
  try{
    const parts=Array.from({length:64},(_,i)=>({
      type:'text',text:'文本 "回归"\\n'+i+':'+('甲乙'.repeat(9000)),
    }))
    const physical=JSON.stringify({id:'native-u7',type:'message',
      message:{role:'user',content:parts}})
    assert.ok(Buffer.byteLength(physical)>2*1024*1024)
    await writeFile(path,physical+'\r\n')
    const sha=createHash('sha256').update(physical+'\r').digest('hex')
    const first=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],expectedSha256:sha,fragmentOffset:0,limit:2,
    })
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.equal(first.record.nativeEventId,'native-u7')
    assert.equal(first.record.nativeType,'message')
    assert.equal(first.record.role,'user')
    assert.equal(first.record.recordSha256,sha)
    assert.deepEqual(first.record.fragments.map(x=>x.ordinal),[0,1])
    assert.equal(first.record.fragments[0]?.text,parts[0]?.text)
    assert.equal(first.record.totalTextFragments,64)
    assert.equal(first.record.nextFragmentOffset,2)
    const next=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],expectedSha256:sha,fragmentOffset:2,limit:2,
    })
    assert.equal(next.state,'available')
    if(next.state!=='available')return
    assert.deepEqual(next.record.fragments.map(x=>x.ordinal),[2,3])
    assert.equal(next.record.fragments[0]?.text,parts[2]?.text)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('a giant individual JSON string is rejected before unbounded allocation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-streamed-scalar-'))
  const path=join(root,'session.jsonl')
  try{
    await writeFile(path,JSON.stringify({type:'message',
      message:{role:'user',content:'X'.repeat(3*1024*1024)}})+'\n')
    assert.deepEqual(await readNativeJsonlTextFragments({
      path,allowedRoots:[root],
    }),{state:'unsupported',reason:'native-record-scalar-budget'})
  }finally{await rm(root,{recursive:true,force:true})}
})

test('rejects invalid JSON, incomplete tail, wrong SHA, bad roots and drift',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-streamed-safe-'))
  const path=join(root,'session.jsonl')
  try{
    await writeFile(path,'{"type":"message","message":{"content":[{"text":"one"}]}}\n')
    const valid=await readNativeJsonlTextFragments({path,allowedRoots:[root]})
    assert.equal(valid.state,'available')
    if(valid.state!=='available')return
    assert.deepEqual(valid.record.fragments,[{ordinal:0,text:'one'}])
    assert.deepEqual(await readNativeJsonlTextFragments({
      path,allowedRoots:[root],expectedSha256:'0'.repeat(64),
    }),{state:'drifted',reason:'native-record-hash-changed'})
    assert.deepEqual(await readNativeJsonlTextFragments({
      path,allowedRoots:[join(root,'elsewhere')],
    }),{state:'unsupported',reason:'source-path-not-authorized'})
    await writeFile(path,'{"type":"message","message":{"content":[{"text":"one"}]}}')
    assert.deepEqual(await readNativeJsonlTextFragments({
      path,allowedRoots:[root],
    }),{state:'pending',reason:'native-record-pending-tail'})
    await appendFile(path,'\n')
    const file=await stat(path)
    assert.deepEqual(await readNativeJsonlTextFragments({
      path,allowedRoots:[root],
      cursor:{offset:0,sequence:0,fileIdentity:'invalid'},
    }),{state:'drifted',reason:'native-file-identity-changed'})
    const abort=new AbortController()
    abort.abort()
    await assert.rejects(readNativeJsonlTextFragments({
      path,allowedRoots:[root],signal:abort.signal,
    }))
    assert.ok(file.size>0)
    await writeFile(path,'{"message":{"content":[{"text":"broken"}]}} invalid\n')
    assert.deepEqual(await readNativeJsonlTextFragments({
      path,allowedRoots:[root],
    }),{state:'unsupported',reason:'native-record-invalid-json'})
  }finally{await rm(root,{recursive:true,force:true})}
})
