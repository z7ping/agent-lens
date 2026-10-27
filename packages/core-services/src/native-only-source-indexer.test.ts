import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import type {
  AgentInstallation, Host, NativeSessionCatalogEntry,
  SourceDefinition,
} from '@agent-lens/core'
import { NativeOnlySourceIndexer, indexNativeInstallation } from './native-only-source-indexer'

const at='2026-10-26T00:00:00.000Z'
const host:Host={id:'host',name:'localhost',platform:'linux',arch:'x64',createdAt:at,lastSeenAt:at}
const installation:AgentInstallation={
  id:'install',hostId:'host',productId:'pi',dataRoot:resolve('source-root'),
  firstSeenAt:at,lastSeenAt:at,
}
const session=(id:string):NativeSessionCatalogEntry=>({
  sourceId:'pi',installationId:'install',nativeSessionId:id,locationKind:'native',
  filePath:resolve('source-root',id+'.jsonl'),fileIdentity:'1:2',fileSize:300,
  fileMtimeMs:100,lastActivityAt:at,updatedAt:at,
})
function makeSource(entries:NativeSessionCatalogEntry[],options:{
  driftId?:string
  verify?:'verified'|'drifted'
  throwRead?:boolean
}={}):SourceDefinition {
  return {
    manifest:{pluginType:'source',sourceId:'pi',productId:'pi',parserVersion:'v1',name:'Pi'},
    // Intentionally NO nativeSessionCoverageComplete flag: Hook gaps must not
    // turn an original native file into a Legacy Writer record.
    async *discoverNativeSessions(ctx:Parameters<NonNullable<SourceDefinition['discoverNativeSessions']>>[0]){
      for(const entry of entries.slice(0,ctx.historyWindow?.sessionLimit??entries.length))yield entry
    },
    async readNativeSessionPage(query:Parameters<NonNullable<SourceDefinition['readNativeSessionPage']>>[0]){
      if(options.throwRead)throw new Error('source file missing')
      return {
        state:'available',hasMore:false,pendingTail:false,
        nextCursor:{fileIdentity:'1:2',offset:300,sequence:1},
        records:[{
          id:'record',sourceId:'pi',installationId:'install',
          sourceSessionNativeId:options.driftId??query.nativeSessionId,
          nativeType:'history/message',capturedAt:at,
          locator:{kind:'file',path:query.filePath,offset:0},
          fingerprint:'hash',
          parserVersion:'v1',
          payload:{entry:{type:'message'}},
        }],
      }
    },
    rawRecovery:{
      describe(){return {
        authority:'native-store',locatorStability:'stable',
        mutability:'append-oriented',verification:'fingerprint',
        canReread:true,canReparse:true,replayable:true,persistencePreference:'reference',
      }},
      async verify(){return {state:options.verify??'verified',checkedAt:at}},
    },
  } as unknown as SourceDefinition
}

test('independent native indexer indexes verifiable original files even with incomplete Hook coverage',async()=>{
  const persisted:NativeSessionCatalogEntry[]=[]
  const indexer=new NativeOnlySourceIndexer({async upsert(entry){persisted.push(entry)}})
  const source=makeSource([session('a'),session('b')])
  const report=await indexer.scan({
    source,host,installation,signal:new AbortController().signal,maxSessions:4,
  })
  assert.equal(report.nativeCoverage,'partial')
  assert.equal(report.indexed,2)
  assert.equal(report.scanned,2)
  assert.equal(report.exhausted,true)
  assert.deepEqual(report.failures,{})
  assert.deepEqual(persisted.map(entry=>entry.nativeSessionId),['a','b'])
})

test('native indexer bounds oversized native titles without altering Source metadata',async()=>{
  const entries=[
    {...session('ascii'),title:'A'.repeat(700)},
    {...session('unicode'),title:'A'.repeat(511)+'😀'.repeat(10)},
    {...session('empty'),title:'  '},
  ]
  const persisted:NativeSessionCatalogEntry[]=[]
  const indexer=new NativeOnlySourceIndexer({async upsert(entry){persisted.push(entry)}})
  const result=await indexer.scan({
    source:makeSource(entries),host,installation,
    signal:new AbortController().signal,maxSessions:4,
  })
  assert.equal(result.indexed,3)
  assert.equal(persisted[0]?.title,'A'.repeat(512))
  assert.equal(persisted[1]?.title,'A'.repeat(511),'do not split an emoji surrogate pair')
  assert.equal(persisted[2]?.title,undefined)
  assert.equal(entries[0]?.title.length,700,'Source-owned title remains unmodified')
})

test('native indexer rejects cross-session evidence and never writes a duplicate record',async()=>{
  let writes=0
  const indexer=new NativeOnlySourceIndexer({async upsert(){writes++}})
  const drift=await indexer.scan({
    source:makeSource([session('a')],{driftId:'different'}),
    host,installation,signal:new AbortController().signal,
  })
  assert.equal(drift.indexed,0)
  assert.equal(drift.failures['record-identity-drifted'],1)
  const unverified=await indexer.scan({
    source:makeSource([session('a')],{verify:'drifted'}),
    host,installation,signal:new AbortController().signal,
  })
  assert.equal(unverified.indexed,0)
  assert.equal(unverified.failures['recovery-unverified'],1)
  const unavailable=await indexer.scan({
    source:makeSource([session('a')],{throwRead:true}),
    host,installation,signal:new AbortController().signal,
  })
  assert.equal(unavailable.failures['source-read-error'],1)
  assert.equal(writes,0)
})

test('native indexer enforces bounded sessions and preserves write errors',async()=>{
  const source=makeSource([session('a'),session('b'),session('c')])
  let stored=0
  const indexer=new NativeOnlySourceIndexer({async upsert(){stored++}})
  const report=await indexer.scan({
    source,host,installation,signal:new AbortController().signal,maxSessions:2,
  })
  assert.equal(stored,2)
  assert.equal(report.exhausted,false)
  await assert.rejects(indexer.scan({
    source,host,installation,signal:new AbortController().signal,maxSessions:5001,
  }),/budget/)
  const failing=new NativeOnlySourceIndexer({async upsert(){throw new Error('sqlite write failed')}})
  await assert.rejects(failing.scan({
    source,host,installation,signal:new AbortController().signal,
  }),/sqlite write failed/)
})

test('offline full enumeration distinguishes source-side skipped headers from true EOF',async()=>{
  const entries=[session('a'),session('invalid-header'),session('b')]
  const source=makeSource(entries)
  const original=source.discoverNativeSessions!
  source.discoverNativeSessions=async function*(ctx){
    for await(const item of original(ctx)){
      if(item.nativeSessionId!=='invalid-header')yield item
    }
  }
  const saved:string[]=[]
  const indexer=new NativeOnlySourceIndexer({async upsert(entry){saved.push(entry.nativeSessionId)}})
  const bounded=await indexer.scan({source,host,installation,
    signal:new AbortController().signal,maxSessions:2})
  assert.equal(bounded.scanned,1)
  saved.length=0
  const complete=await indexer.scan({source,host,installation,
    signal:new AbortController().signal,maxSessions:2,fullEnumeration:true})
  assert.deepEqual(saved,['a','b'])
  assert.equal(complete.scanned,2)
  assert.equal(complete.exhausted,true,'exact-budget natural EOF is complete')
  saved.length=0
  const capped=await indexer.scan({source,host,installation,
    signal:new AbortController().signal,maxSessions:1,fullEnumeration:true})
  assert.equal(capped.scanned,1)
  assert.equal(capped.exhausted,false,'remaining entries must be reported as unexamined')
})

test('indexer never trusts a mismatched Source installation',async()=>{
  const indexer=new NativeOnlySourceIndexer({async upsert(){throw new Error('should not write')}})
  await assert.rejects(indexer.scan({
    source:makeSource([session('a')]),
    host,installation:{...installation,productId:'codex'},
    signal:new AbortController().signal,
  }),/installation identity changed/)
})

test('slim identity port indexes source sessions without Legacy RepositorySet',async()=>{
  const persisted:NativeSessionCatalogEntry[]=[]
  const slimPort={
    nativeSessionCatalog:{
      async upsert(entry:NativeSessionCatalogEntry){persisted.push(entry)},
    },
    repositories:{
      installations:{async get(id:string){return id==='install'?installation:null}},
      hosts:{async get(id:string){return id==='host'?host:null}},
    },
  }
  const report=await indexNativeInstallation(slimPort as never,{
    source:makeSource([session('one')]),installationId:'install',
    signal:new AbortController().signal,
  })
  assert.equal(report.indexed,1)
  assert.equal(persisted[0]?.nativeSessionId,'one')
  await assert.rejects(indexNativeInstallation(slimPort as never,{
    source:makeSource([session('one')]),installationId:'not-found',
    signal:new AbortController().signal,
  }),/installation is not indexed/)
})

test('verified native session cwd creates a Slim launchable workspace and context',async()=>{
  const cwd=resolve('real-native-project')
  const entries=[session('with-cwd')]
  const source=makeSource(entries)
  const read=source.readNativeSessionPage!
  source.readNativeSessionPage=async function(query,ctx){
    const page=await read(query,ctx)
    if(page.state!=='available')return page
    return {...page,records:page.records.map(record=>({
      ...record,payload:{entry:{type:'session'},session:{cwd}},
    }))}
  }
  const workspaces:unknown[]=[]
  const contexts:unknown[]=[]
  const storage={
    nativeSessionCatalog:{async upsert(){}},
    identity:{async resolveWorkspace(hint:{hostId:string;path:string}){
      workspaces.push(hint)
      return {id:'workspace-1',hostId:hint.hostId,path:hint.path,
        projectId:'project-1'}
    }},
    nativeSessionContexts:{async upsert(input:unknown){contexts.push(input)}},
    repositories:{
      installations:{async get(){return installation}},
      hosts:{async get(){return host}},
    },
  }
  const report=await indexNativeInstallation(storage as never,{
    source,installationId:'install',signal:new AbortController().signal,
  })
  assert.equal(report.indexed,1)
  assert.deepEqual(workspaces,[{hostId:host.id,path:cwd}])
  assert.deepEqual(contexts,[{sourceId:'pi',installationId:'install',
    nativeSessionId:'with-cwd',workspaceId:'workspace-1',projectId:'project-1'}])
})

test('native indexer does not invent projects from relative paths or message text',async()=>{
  const source=makeSource([session('without-cwd')])
  const read=source.readNativeSessionPage!
  source.readNativeSessionPage=async function(query,ctx){
    const page=await read(query,ctx)
    if(page.state!=='available')return page
    return {...page,records:page.records.map(record=>({
      ...record,payload:{entry:{cwd:resolve('fake-from-body'),text:'private'},
        session:{cwd:'./relative-path'}},
    }))}
  }
  let workspaceWrites=0,contextWrites=0
  const result=await indexNativeInstallation({
    nativeSessionCatalog:{async upsert(){}},
    identity:{async resolveWorkspace(){workspaceWrites++;return null}},
    nativeSessionContexts:{async upsert(){contextWrites++}},
    repositories:{
      installations:{async get(){return installation}},
      hosts:{async get(){return host}},
    },
  } as never,{source,installationId:'install',signal:new AbortController().signal})
  assert.equal(result.indexed,1)
  assert.equal(workspaceWrites,0)
  assert.equal(contextWrites,0)
})

test('profile-owned native roots and metadata stay attached to the verified session',async()=>{
  const saved:Array<{sourceId:string;nativeSessionId:string;runtimeProfileId?:string}>=[]
  const profile={
    id:'profile',installationId:'install',nativeProfileId:'profile',
    dataRoot:resolve('separate-profile'),configRoot:resolve('profile-config'),
    firstSeenAt:at,lastSeenAt:at,
  }
  const expectedSession={...session('s'),
    filePath:resolve('separate-profile','s.jsonl')}
  const source=makeSource([expectedSession])
  const discovery=source.discoverNativeSessions!
  source.discoverNativeSessions=async function*(ctx){
    assert.equal(ctx.installation.dataRoot,profile.dataRoot)
    yield* discovery(ctx)
  }
  const storage={
    nativeSessionCatalog:{async upsert(entry:NativeSessionCatalogEntry){
      saved.push({sourceId:entry.sourceId,nativeSessionId:entry.nativeSessionId})
    }},
    nativeSessionContexts:{async upsert(input:{
      sourceId:string;installationId:string;nativeSessionId:string;runtimeProfileId?:string
    }){saved.push({sourceId:input.sourceId,nativeSessionId:input.nativeSessionId,
      ...(input.runtimeProfileId?{runtimeProfileId:input.runtimeProfileId}:{})})}},
    repositories:{
      installations:{async get(){return installation}},
      hosts:{async get(){return host}},
    },
  }
  const report=await indexNativeInstallation(storage as never,{
    source,installationId:'install',runtimeProfile:profile,
    signal:new AbortController().signal,
  })
  assert.equal(report.indexed,1)
  assert.equal(saved.length,2)
  assert.equal(saved[0]?.runtimeProfileId,'profile')
  assert.equal(saved[1]?.nativeSessionId,'s')
})

test('native Catalog indexes the first genuine user request but never injected content',async()=>{
  const entry=session('human-title')
  const source=makeSource([entry])
  const original=source.readNativeSessionPage!
  source.readNativeSessionPage=async (query,ctx)=>{
    const page=await original(query,ctx)
    if(page.state!=='available'||query.limit===1)return page
    const record=page.records[0]!
    return {...page,records:[
      {...record,id:'system',nativeType:'system'},
      {...record,id:'user',nativeType:'user'},
      {...record,id:'rename',nativeType:'rename'},
    ]}
  }
  source.normalize=async record=>({
    evidenceCandidates:[],
    observations:[{
      kind:record.nativeType==='rename'?'session.lifecycle':'message.user',
      capturedAt:at,
      identityHints:{
        nativeSessionId:'human-title',
        workspacePath:resolve('verified-workspace'),
        ...(record.nativeType==='rename'?{sessionTitle:'明确命名',sessionTitleKind:'explicit' as const}:{}),
      },
      payload:record.nativeType==='system'
        ?{text:'系统注入的标题',provenance:{actualAuthor:'system',contentRole:'system-context'}}
        :record.nativeType==='user'
          ?{text:'第一条真实用户请求',provenance:{actualAuthor:'human-user',contentRole:'user-request'}}
          :{},
    }],
  })
  const saved:NativeSessionCatalogEntry[]=[]
  const contexts:unknown[]=[]
  await new NativeOnlySourceIndexer({async upsert(value){saved.push(value)}}).scan({
    source,host,installation,signal:new AbortController().signal,
    beforeCatalogUpsert:async (_entry,_record,hints)=>{contexts.push(hints)},
  })
  assert.equal(saved[0]?.title,'明确命名','explicit source title outranks first human request')
  assert.deepEqual(contexts,[{
    title:'明确命名',workspacePath:resolve('verified-workspace'),
  }])
})

test('native Catalog falls back to first human request without storing messages',async()=>{
  const entry=session('human-only')
  const source=makeSource([entry])
  const original=source.readNativeSessionPage!
  source.readNativeSessionPage=async (query,ctx)=>{
    const page=await original(query,ctx)
    if(page.state!=='available'||query.limit===1)return page
    return {...page,records:page.records.map(record=>({
      ...record,nativeType:'user',
    }))}
  }
  source.normalize=async ()=>({
    evidenceCandidates:[],
    observations:[{
      kind:'message.user',capturedAt:at,
      identityHints:{nativeSessionId:'human-only'},
      payload:{text:'恢复真实用户首条请求'}, // Pi user role has implicit provenance
    }],
  })
  const saved:NativeSessionCatalogEntry[]=[]
  await new NativeOnlySourceIndexer({async upsert(value){saved.push(value)}}).scan({
    source,host,installation,signal:new AbortController().signal,
  })
  assert.equal(saved[0]?.title,'恢复真实用户首条请求')
  assert.equal(JSON.stringify(saved).includes('provenance'),false)
  assert.equal(JSON.stringify(saved).includes('observations'),false)
})
