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
    assert.equal(first.record.sourceLineSha256,
      createHash('sha256').update(physical).digest('hex'),
      'CRLF terminator must not change the Source cursor fingerprint')
    assert.deepEqual(first.record.fragments.map(x=>x.ordinal),[0,1])
    assert.ok(first.record.fragments[0]?.text.length>0)
    assert.ok(parts[0]!.text.startsWith(first.record.fragments[0]!.text))
    assert.ok(first.record.totalTextFragments>64)
    assert.equal(first.record.nextFragmentOffset,2)
    const next=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],expectedSha256:sha,fragmentOffset:2,limit:2,
    })
    assert.equal(next.state,'available')
    if(next.state!=='available')return
    assert.deepEqual(next.record.fragments.map(x=>x.ordinal),[2,3])
    assert.ok(next.record.fragments[0]?.text.length>0)
    assert.equal(next.record.nextFragmentOffset,4)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('a 3MiB single JSON string yields resumable UTF-8-safe pieces',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-streamed-scalar-'))
  const path=join(root,'session.jsonl')
  try{
    const content=('🚀 "escaped" 中文\\n'.repeat(180000))
    const record=JSON.stringify({id:'u-big',type:'message',
      message:{role:'user',content}})
    assert.ok(Buffer.byteLength(record)>2*1024*1024)
    await writeFile(path,record+'\\n')
    const first=await readNativeJsonlTextFragments({path,allowedRoots:[root],limit:2})
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.equal(first.record.nativeEventId,'u-big')
    assert.equal(first.record.role,'user')
    assert.deepEqual(first.record.fragments.map(x=>x.ordinal),[0,1])
    assert.ok(first.record.fragments.every(x=>Buffer.byteLength(x.text)<=8192))
    assert.ok(first.record.totalTextFragments>200)
    const second=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],fragmentOffset:2,limit:2,
      expectedSha256:first.record.recordSha256,
    })
    assert.equal(second.state,'available')
    if(second.state!=='available')return
    assert.deepEqual(second.record.fragments.map(x=>x.ordinal),[2,3])
    const prefix=[...first.record.fragments,...second.record.fragments]
      .map(x=>x.text).join('')
    assert.equal(content.startsWith(prefix),true,
      'decoded UTF-8 and escaped text must reassemble without omissions')
    const tail=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],
      fragmentOffset:first.record.totalTextFragments-1,limit:1,
      expectedSha256:first.record.recordSha256,
    })
    assert.equal(tail.state,'available')
    if(tail.state==='available')assert.equal(tail.record.nextFragmentOffset,undefined)
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
    assert.deepEqual(valid.record.fragments,[{ordinal:0,text:'one',kind:'message',contentIndex:0}])
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

test('no primitive JSONL root or unsafe fragment window is accepted',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-streamed-object-'))
  const path=join(root,'session.jsonl')
  try{
    await writeFile(path,'42\n')
    assert.deepEqual(await readNativeJsonlTextFragments({path,allowedRoots:[root]}),
      {state:'unsupported',reason:'native-record-not-object'})
    assert.deepEqual(await readNativeJsonlTextFragments({
      path,allowedRoots:[root],fragmentOffset:-1,
    }),{state:'unsupported',reason:'invalid-fragment-window'})
  }finally{await rm(root,{recursive:true,force:true})}
})

test('large media strings are ignored without materializing binary-as-text',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-streamed-media-'))
  const path=join(root,'session.jsonl')
  try{
    const record=JSON.stringify({id:'media-u',type:'message',
      message:{role:'user',content:[
        {type:'image',data:'A'.repeat(3*1024*1024)},
        {type:'text',text:'visible text'},
      ]},
    })
    await writeFile(path,record+'\\n')
    const out=await readNativeJsonlTextFragments({path,allowedRoots:[root],limit:2})
    assert.equal(out.state,'available')
    if(out.state==='available'){
      assert.deepEqual(out.record.fragments,[{ordinal:0,text:'visible text',kind:'message',contentIndex:1}])
      assert.equal(out.record.totalTextFragments,1)
    }
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Pi thinking and tool evidence preserve original positions and opaque call association',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-streamed-tool-evidence-'))
  const path=join(root,'session.jsonl')
  try{
    const id='native-call-741'
    const callKey=createHash('sha256').update(id).digest('hex')
    await writeFile(path,JSON.stringify({id:'assistant-entry',type:'message',
      message:{role:'assistant',content:[
        {type:'thinking',thinking:'Check the project first'},
        {type:'toolCall',id,name:'read',arguments:{path:'src/main.ts',options:{note:'bounded'}}},
        {type:'text',text:'Found the file'},
        {type:'image',data:'A'.repeat(3*1024*1024)},
      ]},
    })+'\n')
    const call=await readNativeJsonlTextFragments({path,allowedRoots:[root],limit:8})
    assert.equal(call.state,'available')
    if(call.state!=='available')return
    const pieces=call.record.fragments
    assert.deepEqual(pieces.map(x=>x.kind),['thinking','tool-call','tool-call','message'])
    assert.deepEqual(pieces.map(x=>x.contentIndex),[0,1,1,2])
    assert.equal(pieces[1]?.callKey,callKey)
    assert.equal(pieces[2]?.callKey,callKey)
    assert.equal(pieces[0]?.callKey,undefined)
    assert.equal(JSON.stringify(pieces).includes(id),false)
    assert.equal(call.record.nativeEventId,'assistant-entry')
    assert.equal(call.record.totalTextFragments,4)
    await writeFile(path,JSON.stringify({id:'tool-entry',type:'message',
      message:{role:'toolResult',toolCallId:id,content:[{type:'text',text:'read complete'}]},
    })+'\n')
    const result=await readNativeJsonlTextFragments({path,allowedRoots:[root]})
    assert.equal(result.state,'available')
    if(result.state==='available')assert.deepEqual(result.record.fragments,[{
      ordinal:0,kind:'tool-result',contentIndex:0,text:'read complete',callKey,
    }])
  }finally{await rm(root,{recursive:true,force:true})}
})

test('unknown and late tool argument types are not exposed as verified tool evidence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-streamed-tool-safe-'))
  const path=join(root,'session.jsonl')
  try{
    await writeFile(path,JSON.stringify({type:'message',
      message:{role:'assistant',content:[
        {arguments:{secret:'unverified'},type:'toolCall',id:'late'},
        {type:'toolCall',id:'known',arguments:{base64:'A'.repeat(3*1024*1024),text:'safe'}},
      ]},
    })+'\n')
    const result=await readNativeJsonlTextFragments({path,allowedRoots:[root]})
    assert.equal(result.state,'available')
    if(result.state==='available'){
      assert.equal(result.record.totalTextFragments,1)
      assert.deepEqual(result.record.fragments.map(x=>x.text),['safe'])
      assert.equal(result.record.fragments[0]?.kind,'tool-call')
      assert.equal(result.record.fragments[0]?.contentIndex,1)
    }
  }finally{await rm(root,{recursive:true,force:true})}
})
