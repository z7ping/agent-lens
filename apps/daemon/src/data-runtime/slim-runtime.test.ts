import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteSlimStorage, SqliteStorageService } from '@agent-lens/storage-sqlite'
import { SlimDataRuntime } from './slim-runtime'

const args=(name:string)=>{
  const log:Array<{method:string;path?:unknown}>= []
  const port={
    async start(){log.push({method:'start'})},
    async shutdown(){log.push({method:'shutdown'})},
    async request(_method:string,params?:Record<string,unknown>){
      log.push({method:name,path:params?.path})
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
