import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteSlimStorage, SqliteStorageService } from '@agent-lens/storage-sqlite'
import { SlimDataRuntime } from './slim-runtime'
import type { NativeSessionReaderStorage } from '@agent-lens/core-services'

const args=(name:string)=>{
  const log:Array<{method:string;path?:unknown}>= []
  const port={
    async start(){log.push({method:'start'})},
    async shutdown(){log.push({method:'shutdown'})},
    async request(_method:string,params?:Record<string,unknown>){
      log.push({method:name,path:params?.path})
      if(Array.isArray(params?.path)&&params.path[0]==='repositories'
        &&Array.isArray(params.args)&&params.args[0]==='missing')return null
      if(Array.isArray(params?.path)&&params.path[0]==='nativeSessionList'){
        return {items:[],hasMore:false}
      }
      return {ok:true,schemaVersion:1}
    },
  }
  return {port,log}
}

test('dedicated slim worker port exposes bounded Native read/metadata writes only',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'al-slim-runtime-'))
  const dbPath=join(directory,'slim.sqlite')
  const db=await SqliteSlimStorage.createFresh(dbPath)
  await db.close()
  const writer=args('writer'),reader=args('reader')
  const runtime=new SlimDataRuntime({
    dbPath,writer:writer.port as never,reader:reader.port as never,
  })
  try{
    await runtime.start()
    assert.deepEqual((await runtime.sessions({limit:10})).items,[])
    assert.equal((await runtime.health()).ok,true)
    assert.equal(reader.log.filter(item=>item.method==='reader').length,2)
    assert.equal(writer.log.filter(item=>item.method==='writer').length,0)
    assert.equal('legacyWriter' in runtime,false)
    assert.equal('observations' in runtime,false)
  }finally{
    await runtime.shutdown()
    await rm(directory,{recursive:true,force:true})
  }
})

test('slim runtime refuses legacy v38 and absent databases before worker start',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'al-slim-guard-'))
  const dbPath=join(directory,'legacy.sqlite')
  const old=new SqliteStorageService({path:dbPath})
  await old.migrate()
  await old.close()
  const writer=args('writer'),reader=args('reader')
  try{
    await assert.rejects(new SlimDataRuntime({
      dbPath,writer:writer.port as never,reader:reader.port as never,
    }).start(),/slim|Slim|required/i)
    assert.deepEqual(writer.log,[])
    await assert.rejects(new SlimDataRuntime({
      dbPath:join(directory,'missing.sqlite'),
      writer:writer.port as never,reader:reader.port as never,
    }).start(),/unable to open|does not exist|not found/i)
    assert.deepEqual(writer.log,[])
  }finally{await rm(directory,{recursive:true,force:true})}
})

test('native-only installation discovery writes identities/Profile through Slim Worker, not Legacy',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'al-slim-discovery-'))
  const dbPath=join(directory,'native.sqlite')
  const db=await SqliteSlimStorage.createFresh(dbPath)
  await db.close()
  const writer=args('writer'),reader=args('reader')
  const runtime=new SlimDataRuntime({
    dbPath,writer:writer.port as never,reader:reader.port as never,
  })
  try{
    await runtime.start()
    await runtime.resolveHost({name:'host',platform:'linux',arch:'x64'})
    await runtime.resolveInstallation({hostId:'host-id',productId:'pi',dataRoot:'/native/pi'})
    await runtime.resolveProfile({installationId:'pi-install',nativeProfileId:'main',
      dataRoot:'/native/pi/profile'})
    assert.deepEqual(writer.log.filter(x=>x.method==='writer').map(x=>x.path),[
      ['identity','resolveHost'],
      ['identity','resolveInstallation'],
      ['runtimeProfiles','resolve'],
    ])
    assert.deepEqual(reader.log.filter(x=>x.method==='reader'),[])
  }finally{await runtime.shutdown();await rm(directory,{recursive:true,force:true})}
})

test('slim Daemon bridge routes reader/catalog/context/metrics/checkpoints to isolated Worker roles',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'al-slim-bridge-'))
  const dbPath=join(directory,'native.sqlite')
  const original=await SqliteSlimStorage.createFresh(dbPath)
  await original.close()
  const writer=args('writer'),reader=args('reader')
  const runtime=new SlimDataRuntime({
    dbPath,writer:writer.port as never,reader:reader.port as never,
  })
  try{
    await runtime.start()
    const port:NativeSessionReaderStorage=runtime.nativePort()
    await port.repositories.hosts.get('h')
    await port.repositories.installations.get('i')
    await port.nativeSessionCatalog!.get({
      sourceId:'pi',installationId:'i',nativeSessionId:'s',
    })
    await port.nativeSessionCatalog!.upsert({
      sourceId:'pi',installationId:'i',nativeSessionId:'s',
      locationKind:'native',filePath:'/source/s.jsonl',fileIdentity:'id',
      fileSize:100,fileMtimeMs:2,lastActivityAt:'2026-10-26',updatedAt:'2026-10-26',
    })
    await runtime.nativePort().nativeSessionContexts.upsert({
      sourceId:'pi',installationId:'i',nativeSessionId:'s',
    })
    await runtime.nativePort().nativeSessionMetrics.invalidate({
      sourceId:'pi',installationId:'i',nativeSessionId:'s',
    })
    await runtime.nativePort().checkpoints.set('capture','cursor',{offset:1})
    const reads=reader.log.filter(item=>item.method==='reader')
      .map(item=>item.path)
    const writes=writer.log.filter(item=>item.method==='writer')
      .map(item=>item.path)
    assert.deepEqual(reads,[
      ['repositories','hosts','get'],
      ['repositories','installations','get'],
      ['nativeSessionCatalog','get'],
    ])
    assert.deepEqual(writes,[
      ['nativeSessionCatalog','upsert'],
      ['nativeSessionContexts','upsert'],
      ['nativeSessionMetrics','invalidate'],
      ['checkpoints','set'],
    ])
  }finally{
    await runtime.shutdown()
    await rm(directory,{recursive:true,force:true})
  }
})

test('Slim HTTP bridge serves existing native list, facets, Catalog and aggregate RPC without Legacy repositories',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'al-slim-native-http-'))
  const dbPath=join(directory,'native.sqlite')
  const db=await SqliteSlimStorage.createFresh(dbPath)
  await db.close()
  const writer=args('writer'),reader=args('reader')
  const runtime=new SlimDataRuntime({
    dbPath,writer:writer.port as never,reader:reader.port as never,
  })
  try{
    await runtime.start()
    const http=runtime.nativeHttpPort()
    assert.equal('repositories' in http,false)
    assert.equal('sessionSummaries' in http,false)
    await http.nativeSessionCatalog.get({
      sourceId:'pi',installationId:'i',nativeSessionId:'s',
    })
    await http.nativeSessionCatalog.getByReviewSessionId('native:00000000000000000000000000000000')
    await http.nativeSessionCatalog.query({limit:10})
    assert.ok(http.nativeSessionCatalog.isNativeMetricsEligible)
    await http.nativeSessionCatalog.isNativeMetricsEligible({
      sourceId:'pi',installationId:'i',nativeSessionId:'s',
    })
    await http.nativeSessionList.query({limit:10})
    await http.nativeFacets.query()
    await http.installations.get('install')
    await http.launchableProjects.query({limit:10})
    await http.launchableProjects.recordWorkspaceValidation?.({
      workspaceId:'workspace-1',workspacePath:'/work/example',
      status:'valid',validatedAt:'2026-10-26T00:00:00.000Z',
    })
    await http.nativeSessionMetrics.get({
      sourceId:'pi',installationId:'i',nativeSessionId:'s',
    })
    await http.nativeSessionMetrics.overview!({sourceId:'pi',parserVersion:'v1'})
    await http.nativeSessionMetrics.findRebuildCandidates!(
      {sourceId:'pi',parserVersion:'v1'},4)
    await http.health()
    const reads=reader.log.filter(item=>item.method==='reader').map(item=>item.path)
    assert.deepEqual(reads,[
      ['nativeSessionCatalog','get'],['nativeSessionCatalog','getByReviewSessionId'],
      ['nativeSessionCatalog','query'],['nativeSessionCatalog','isNativeMetricsEligible'],
      ['nativeSessionList','query'],['nativeFacets','query'],
      ['repositories','installations','get'],['launchableProjects','query'],
      ['nativeSessionMetrics','get'],['nativeSessionMetrics','overview'],
      ['nativeSessionMetrics','findRebuildCandidates'],['health'],
    ])
    assert.deepEqual(writer.log.filter(item=>item.method==='writer').map(item=>item.path),[
      ['launchableProjects','recordWorkspaceValidation'],
    ])
  }finally{await runtime.shutdown();await rm(directory,{recursive:true,force:true})}
})

test('Slim Profile enumeration is routed through the read-only Worker allowlist',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'al-slim-profiles-'))
  const dbPath=join(directory,'native.sqlite')
  const db=await SqliteSlimStorage.createFresh(dbPath)
  await db.close()
  const writer=args('writer'),reader=args('reader')
  const runtime=new SlimDataRuntime({
    dbPath,writer:writer.port as never,reader:reader.port as never,
  })
  try{
    await runtime.start()
    await runtime.profiles('installation')
    assert.deepEqual(reader.log.filter(item=>item.method==='reader').map(item=>item.path),
      [['runtimeProfiles','listByInstallation']])
    assert.equal(writer.log.filter(item=>item.method==='writer').length,0)
  }finally{await runtime.shutdown();await rm(directory,{recursive:true,force:true})}
})

test('Slim Reader is composed directly from Native ports and owned by Slim shutdown',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'al-slim-reader-compose-'))
  const dbPath=join(directory,'native.sqlite')
  const db=await SqliteSlimStorage.createFresh(dbPath)
  await db.close()
  const writer=args('writer'),reader=args('reader')
  const runtime=new SlimDataRuntime({
    dbPath,writer:writer.port as never,reader:reader.port as never,
  })
  const sources={list:()=>[]} as never
  const policy={isSourceEnabled:()=>false} as never
  try{
    assert.throws(()=>runtime.nativeReader(sources,policy),/not started/)
    await runtime.start()
    const first=runtime.nativeReader(sources,policy)
    assert.equal(typeof first.read,'function')
    assert.equal(typeof first.readArchivedHooks,'function')
    const second=runtime.nativeReader(sources,policy)
    assert.notEqual(first,second,'each caller owns its view, Runtime owns one bounded worker')
    assert.deepEqual(writer.log.filter(item=>item.method==='writer'),[])
    assert.deepEqual(reader.log.filter(item=>item.method==='reader'),[])
    const denied=await first.read({
      sourceId:'pi',installationId:'install',nativeSessionId:'s',
      signal:new AbortController().signal,
    })
    assert.deepEqual(denied,{state:'unsupported',reason:'source-disabled'})
  }finally{await runtime.shutdown();await rm(directory,{recursive:true,force:true})}
})


test('Slim Source asset discovery persists metadata only via allowlisted Worker methods',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'al-slim-current-assets-'))
  const dbPath=join(directory,'native.sqlite')
  const db=await SqliteSlimStorage.createFresh(dbPath)
  await db.close()
  const writer=args('writer'),reader=args('reader')
  const runtime=new SlimDataRuntime({
    dbPath,writer:writer.port as never,reader:reader.port as never,
  })
  try{
    await runtime.start()
    const source={
      manifest:{sourceId:'pi',productId:'pi'},
      async *discoverAssets(){
        yield {definition:{type:'skill',canonicalName:'fixture-skill'},
          binding:{path:'/native/skills/fixture-skill'},
          states:[{state:'installed',value:true,observedAt:'2026-10-26T00:00:00Z'}]}
      },
    }
    // The fake Worker has no real backing rows; assert the full error does
    // not turn into a Legacy call and the Reader only touches identity.
    const policy={
      isEnabled:()=>true,
      isSourceEnabled:()=>true,
      sanitizeDiscoveredAsset:(value:unknown)=>value,
    }
    await assert.rejects(
      runtime.scanInstallationAssets({
        source:source as never,installationId:'missing',
        policy:policy as never,signal:new AbortController().signal,
      }),
      /unavailable/,
    )
    assert.deepEqual(reader.log.filter(x=>x.method==='reader').map(x=>x.path),
      [['repositories','installations','get']])
    assert.deepEqual(writer.log.filter(x=>x.method==='writer'),[])
  }finally{await runtime.shutdown();await rm(directory,{recursive:true,force:true})}
})
