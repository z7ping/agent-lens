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
    assert.deepEqual(pieces[1]?.fieldKeys,['arguments','path'])
    assert.deepEqual(pieces[2]?.fieldKeys,['arguments','options','note'])
    assert.equal(pieces[0]?.fieldKeys,undefined)
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

test('large Pi inline image is indexed without materialization and paged by bounded verified base64',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-inline-image-'))
  const path=join(root,'session.jsonl')
  try{
    const data='AQID'.repeat(900000)
    const record=JSON.stringify({id:'image-original',type:'message',
      message:{role:'user',content:[
        {type:'text',text:'before'},
        {data,mimeType:'image/png',type:'image'},
      ]},
    })
    assert.ok(Buffer.byteLength(record)>2*1024*1024)
    await writeFile(path,record+'\n')
    const text=await readNativeJsonlTextFragments({path,allowedRoots:[root],limit:2})
    assert.equal(text.state,'available')
    if(text.state!=='available')return
    assert.deepEqual(text.record.images,[{contentIndex:1,mimeType:'image/png'}])
    assert.deepEqual(text.record.fragments.map(x=>x.text),['before'])
    assert.equal(JSON.stringify(text.record).includes(data.slice(0,200)),false)
    const media=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],expectedSha256:text.record.recordSha256,
      media:{contentIndex:1,offset:0,limit:128*1024},
    })
    assert.equal(media.state,'available')
    if(media.state!=='available')return
    assert.equal(media.record.media?.base64,data.slice(0,128*1024))
    assert.equal(media.record.media?.totalBase64Length,data.length)
    assert.equal(media.record.media?.nextOffset,128*1024)
    assert.equal(media.record.fragments.length,0)
    const tail=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],expectedSha256:text.record.recordSha256,
      media:{contentIndex:1,offset:128*1024,limit:128*1024},
    })
    assert.equal(tail.state,'available')
    if(tail.state==='available')
      assert.equal(tail.record.media?.base64,data.slice(128*1024,256*1024))
    assert.deepEqual(await readNativeJsonlTextFragments({
      path,allowedRoots:[root],media:{contentIndex:1,offset:4,limit:4},
    }),{state:'unsupported',reason:'invalid-native-media-window'})
  }finally{await rm(root,{recursive:true,force:true})}
})

test('inline media rejects untrusted MIME, invalid base64 and unauthorized image selectors',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-inline-image-invalid-'))
  const path=join(root,'session.jsonl')
  try{
    await writeFile(path,JSON.stringify({type:'message',message:{role:'user',content:[
      {type:'image',mimeType:'image/svg+xml',data:'PHN2Zz4='},
      {type:'image',mimeType:'image/png',data:'not:base64'},
      {type:'text',text:'safe'},
    ]}})+'\n')
    const text=await readNativeJsonlTextFragments({path,allowedRoots:[root]})
    assert.equal(text.state,'available')
    if(text.state!=='available')return
    assert.deepEqual(text.record.images,[{contentIndex:1,mimeType:'image/png'}])
    assert.deepEqual(text.record.fragments.map(x=>x.text),['safe'])
    const failed=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],expectedSha256:text.record.recordSha256,
      media:{contentIndex:1,offset:0,limit:128},
    })
    assert.deepEqual(failed,{state:'unsupported',reason:'invalid-native-image-base64'})
    const wrongType=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],expectedSha256:text.record.recordSha256,
      media:{contentIndex:0,offset:0,limit:128},
    })
    assert.deepEqual(wrongType,{state:'unsupported',reason:'native-inline-image-not-found'})
  }finally{await rm(root,{recursive:true,force:true})}
})

test('tool argument fragments retain private nested field ancestry without exposing it as public evidence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-tool-private-keys-'))
  const path=join(root,'session.jsonl')
  try{
    await writeFile(path,JSON.stringify({type:'message',
      message:{role:'assistant',content:[{type:'toolCall',id:'call-sensitive',
        arguments:{credentials:{api_key:'VALUE_NOT_A_TOKEN',password:'plain-value'},
          items:[{token:'another-plain-value'}],
          path:'src/index.ts'}}]},
    })+'\n')
    const result=await readNativeJsonlTextFragments({path,allowedRoots:[root]})
    assert.equal(result.state,'available')
    if(result.state!=='available')return
    assert.deepEqual(result.record.fragments.map(x=>x.fieldKeys),[
      ['arguments','credentials','api_key'],
      ['arguments','credentials','password'],
      ['arguments','items','token'],
      ['arguments','path'],
    ])
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Pi typed tool scalar leaves preserve numeric precision, booleans and null order',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-tool-native-scalars-'))
  const path=join(root,'session.jsonl')
  try{
    const record=JSON.stringify({type:'message',message:{role:'assistant',content:[
      {type:'toolCall',id:'call-typed',name:'test',arguments:{
        retries:42,enabled:true,disabled:false,unset:null,
        ratio:1.25e-7,nested:[1,false,null,'tail'],
      }},
      {type:'text',text:'done'},
    ]}})
    await writeFile(path,record+'\n')
    const result=await readNativeJsonlTextFragments({path,allowedRoots:[root],limit:16})
    assert.equal(result.state,'available')
    if(result.state!=='available')return
    const pieces=result.record.fragments
    assert.deepEqual(pieces.map(x=>x.text),
      ['42','true','false','null','1.25e-7','1','false','null','tail','done'])
    assert.deepEqual(pieces.map(x=>x.valueType),[
      'number','boolean','boolean','null','number',
      'number','boolean','null','string',undefined,
    ])
    assert.deepEqual(pieces.map(x=>x.kind),[
      ...Array.from({length:9},()=> 'tool-call'),'message',
    ])
    assert.deepEqual(pieces[0]?.fieldKeys,['arguments','retries'])
    assert.deepEqual(pieces[5]?.fieldKeys,['arguments','nested'])
    assert.deepEqual(pieces[8]?.fieldKeys,['arguments','nested'])
    assert.ok(pieces.slice(0,9).every(x=>x.callKey===pieces[0]?.callKey))
    assert.equal(result.record.totalTextFragments,10)
    const next=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],fragmentOffset:4,limit:3,
      expectedSha256:result.record.recordSha256,
    })
    assert.equal(next.state,'available')
    if(next.state==='available')
      assert.deepEqual(next.record.fragments.map(x=>x.ordinal),[4,5,6])
  }finally{await rm(root,{recursive:true,force:true})}
})

test('overlong Pi tool numeric literals are rejected without materializing a huge scalar',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-tool-native-number-bound-'))
  const path=join(root,'session.jsonl')
  try{
    const record='{"type":"message","message":{"role":"assistant","content":['
      +'{"type":"toolCall","arguments":{"count":'+('9'.repeat(400))+'}}]}}'
    await writeFile(path,record+'\n')
    assert.deepEqual(await readNativeJsonlTextFragments({path,allowedRoots:[root]}),{
      state:'unsupported',reason:'native-tool-number-budget',
    })
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Pi tool result details expose only typed evidence leaves with native call association',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-tool-result-details-'))
  const path=join(root,'session.jsonl')
  try{
    const id='call-result-typed'
    const record=JSON.stringify({type:'message',message:{
      role:'toolResult',toolCallId:id,content:[{type:'text',text:'done'}],
      details:{status:200,success:true,missing:null,
        credentials:{token:'plain-sensitive-value'},
        observations:[3,false,'detail'],
        image:{data:'A'.repeat(3*1024*1024)}},
    }})
    await writeFile(path,record+'\n')
    const result=await readNativeJsonlTextFragments({path,allowedRoots:[root],limit:16})
    assert.equal(result.state,'available')
    if(result.state!=='available')return
    const parts=result.record.fragments
    assert.deepEqual(parts.map(x=>x.text),[
      'done','200','true','null','plain-sensitive-value','3','false','detail',
    ])
    assert.deepEqual(parts.map(x=>x.kind),Array(8).fill('tool-result'))
    assert.deepEqual(parts.map(x=>x.valueType),[
      undefined,'number','boolean','null','string','number','boolean','string',
    ])
    assert.deepEqual(parts[4]?.fieldKeys,['details','credentials','token'])
    assert.deepEqual(parts[5]?.fieldKeys,['details','observations'])
    const key=createHash('sha256').update(id).digest('hex')
    assert.ok(parts.every(piece=>piece.callKey===key))
    assert.ok(parts.every(piece=>piece.text.length<3*1024*1024))
    assert.equal(result.record.totalTextFragments,8)
    const next=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],fragmentOffset:4,limit:2,
      expectedSha256:result.record.recordSha256,
    })
    assert.equal(next.state,'available')
    if(next.state==='available')
      assert.deepEqual(next.record.fragments.map(x=>x.ordinal),[4,5])
  }finally{await rm(root,{recursive:true,force:true})}
})

test('unverified role ordering cannot promote arbitrary details to tool result evidence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-tool-result-role-'))
  const path=join(root,'session.jsonl')
  try{
    const input={type:'message',message:{
      details:{token:'not-proof',code:400},role:'toolResult',
      content:[{type:'text',text:'verified later'}],
    }}
    await writeFile(path,JSON.stringify(input)+'\n')
    const result=await readNativeJsonlTextFragments({path,allowedRoots:[root]})
    assert.equal(result.state,'available')
    if(result.state==='available'){
      assert.deepEqual(result.record.fragments.map(x=>x.text),['verified later'])
      assert.equal(JSON.stringify(result.record.fragments).includes('not-proof'),false)
    }
  }finally{await rm(root,{recursive:true,force:true})}
})

test('oversized Pi JSONL certifies ordered content blocks without reassembling images or creating events',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-content-outline-'))
  const path=join(root,'session.jsonl')
  try{
    const id='call-native-block-1'
    const data='A'.repeat(2_300_000)
    const body=JSON.stringify({id:'message-native-1',type:'message',
      message:{role:'assistant',content:[
        {type:'text',text:'first'},
        {type:'thinking',thinking:'plan'},
        {type:'toolCall',id,name:'read_file',arguments:{path:'README.md',attempts:2}},
        {type:'image',mimeType:'image/png',data},
        {type:'custom',payload:{flag:true}},
      ]},
    })
    assert.ok(Buffer.byteLength(body)>2*1024*1024)
    await writeFile(path,body+'\n')
    const first=await readNativeJsonlTextFragments({path,allowedRoots:[root],
      fragmentOffset:0,limit:1})
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.equal(first.record.nativeEventId,'message-native-1')
    assert.deepEqual(first.record.contentBlocks,[
      {contentIndex:0,kind:'text',fragmentCount:1},
      {contentIndex:1,kind:'thinking',fragmentCount:1},
      {contentIndex:2,kind:'tool-call',fragmentCount:2,name:'read_file',
        callKey:createHash('sha256').update(id).digest('hex')},
      {contentIndex:3,kind:'image',fragmentCount:0},
      {contentIndex:4,kind:'other',fragmentCount:0},
    ])
    assert.equal(first.record.contentBlocksTruncated,undefined)
    assert.equal(first.record.fragments.length,1)
    assert.ok(first.record.images.some(item=>item.contentIndex===3))
    assert.equal(JSON.stringify(first.record).includes(data.slice(0,256)),false)
    const next=await readNativeJsonlTextFragments({path,allowedRoots:[root],
      fragmentOffset:1,limit:2,expectedSha256:first.record.recordSha256})
    assert.equal(next.state,'available')
    if(next.state==='available'){
      assert.deepEqual(next.record.contentBlocks,first.record.contentBlocks,
        'block identities are independent of text window offset')
      assert.deepEqual(next.record.fragments.map(item=>item.ordinal),[1,2])
    }
  }finally{await rm(root,{recursive:true,force:true})}
})

test('native content outline is bounded to 64 verified blocks and does not claim full coverage',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-outline-budget-'))
  const path=join(root,'session.jsonl')
  try{
    const content=Array.from({length:71},(_,i)=>({type:'text',text:'part'+i}))
    await writeFile(path,JSON.stringify({type:'message',message:{
      role:'assistant',content,
    }})+'\n')
    const result=await readNativeJsonlTextFragments({path,allowedRoots:[root],limit:2})
    assert.equal(result.state,'available')
    if(result.state!=='available')return
    assert.equal(result.record.contentBlocks.length,64)
    assert.equal(result.record.contentBlocksTruncated,true)
    assert.equal(result.record.contentBlocks[0]?.contentIndex,0)
    assert.equal(result.record.contentBlocks[63]?.contentIndex,63)
    assert.equal(result.record.totalTextFragments,71,
      'bounded metadata does not silently drop Source text facts')
  }finally{await rm(root,{recursive:true,force:true})}
})

test('overlong optional tool display names cannot erase other certified native content',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-optional-name-'))
  const path=join(root,'session.jsonl')
  try{
    const source=JSON.stringify({type:'message',message:{role:'assistant',
      content:[{type:'toolCall',id:'trusted-id',name:'n'.repeat(1200),
        arguments:{file:'readme'}},{type:'text',text:'done'}]}})
    await writeFile(path,source+'\n')
    const result=await readNativeJsonlTextFragments({path,allowedRoots:[root]})
    assert.equal(result.state,'available')
    if(result.state!=='available')return
    assert.deepEqual(result.record.contentBlocks,[
      {contentIndex:0,kind:'tool-call',fragmentCount:1,
        callKey:createHash('sha256').update('trusted-id').digest('hex')},
      {contentIndex:1,kind:'text',fragmentCount:1},
    ])
    assert.deepEqual(result.record.fragments.map(x=>x.text),['readme','done'])
    assert.equal(JSON.stringify(result.record).includes('n'.repeat(512)),false)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('a giant scalar has safe split proof only across non-ASCII boundaries',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-safe-boundary-'))
  const path=join(root,'session.jsonl')
  try{
    await writeFile(path,JSON.stringify({type:'message',id:'unicode',message:{
      role:'user',content:'中文🚀'.repeat(200_000),
    }})+'\n')
    const safe=await readNativeJsonlTextFragments({path,allowedRoots:[root],limit:3})
    assert.equal(safe.state,'available')
    if(safe.state!=='available')return
    assert.equal(safe.record.strictLargeScalarShape,true)
    assert.equal(safe.record.scalarContentVerified,true)
    assert.ok(safe.record.totalTextFragments>16)
    assert.ok(safe.record.fragments.every(piece=>
      piece.splitScalar===true&&piece.safeSplitScalar===true))
    await writeFile(path,JSON.stringify({type:'message',id:'ascii',message:{
      role:'user',content:'Bearer '+('secret'.repeat(400_000)),
    }})+'\n')
    const unsafe=await readNativeJsonlTextFragments({path,allowedRoots:[root],limit:3})
    assert.equal(unsafe.state,'available')
    if(unsafe.state==='available')
      assert.ok(unsafe.record.fragments.every(piece=>
        piece.splitScalar===true&&piece.safeSplitScalar!==true),
        'an ASCII credential crossing the fragment boundary is never independently disclosed')
  }finally{await rm(root,{recursive:true,force:true})}
})

test('native oversized tool arguments preserve exact bounded flat scalar types and reject nesting',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-verified-flat-args-'))
  const path=join(root,'session.jsonl')
  try{
    const make=(args:unknown)=>JSON.stringify({type:'message',id:'assistant-with-args',
      message:{role:'assistant',content:[
        {type:'toolCall',id:'authentic-call',name:'read',
          arguments:args},
        {type:'image',mimeType:'image/png',data:'A'.repeat(2_250_000)},
      ]},
    })
    await writeFile(path,make({file:'README.md',count:2,enabled:true,
      optional:null})+'\n')
    const verified=await readNativeJsonlTextFragments({
      path,allowedRoots:[root],limit:8,
    })
    assert.equal(verified.state,'available')
    if(verified.state!=='available')return
    assert.equal(verified.record.strictLargeAssistantShape,true)
    const block=verified.record.contentBlocks[0]
    assert.equal(block?.nativeCallId,'authentic-call')
    assert.deepEqual(block?.verifiedArguments,
      {file:'README.md',count:2,enabled:true,optional:null})
    for(const unsupported of [
      {nested:{path:'README.md'}},{items:['a','b']},
      {deep:'x'.repeat(16_000)},
    ]){
      await writeFile(path,make(unsupported)+'\n')
      const result=await readNativeJsonlTextFragments({
        path,allowedRoots:[root],limit:8,
      })
      assert.equal(result.state,'available')
      if(result.state==='available')
        assert.equal(result.record.strictLargeAssistantShape,false,
          'nested, arrays and over-budget scalars cannot be considered complete')
    }
  }finally{await rm(root,{recursive:true,force:true})}
})
