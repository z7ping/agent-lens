import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp,mkdir,writeFile,readFile,rm,rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn,spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { runInNewContext } from 'node:vm'
import Database from 'better-sqlite3'
import { SqliteStorageService,auditSlimCutoverFreshness } from '@agent-lens/storage-sqlite'
import { piManifest } from '@agent-lens/source-pi'
import { prepareSlimCutover } from '../slim-prepare-cutover'
import { finalizeSlimCutover,rollbackSlimCutover,readActiveDatabasePointer } from '../slim-cutover-activation'

const at='2026-10-26T00:00:00.000Z'
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
async function freePort(){
  const server=createServer()
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const port=address.port
  await new Promise<void>(done=>server.close(()=>done()))
  return port
}
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'al-m3-real-'))
  const home=join(root,'home'),data=join(home,'.agent-lens','1.0'),sessions=join(root,'sessions')
  await mkdir(data,{recursive:true});await mkdir(sessions,{recursive:true})
  const file=join(sessions,'sample.jsonl')
  const event=JSON.stringify({type:'message',id:'user-1',timestamp:at,
    message:{role:'user',content:[{type:'text',text:'M3 验收输入'}],timestamp:Date.parse(at)}})
  const header=JSON.stringify({type:'session',version:3,id:'m3-session',timestamp:at,cwd:root})
  const assistant=JSON.stringify({type:'message',id:'assistant-1',parentId:'user-1',timestamp:at,
    message:{role:'assistant',content:[{type:'text',text:'M3 验收输出'}],api:'openai-responses',provider:'openai',model:'fixture',
      usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      stopReason:'stop',timestamp:Date.parse(at)}})
  await writeFile(file,[header,event,assistant].join('\n')+'\n')
  const legacyPath=join(data,'agent-lens.db')
  const old=new SqliteStorageService({path:legacyPath})
  try{
    await old.migrate()
    old.db.prepare(`INSERT INTO hosts(id,name,platform,arch,created_at,last_seen_at) VALUES('h','test',?,?,?,?)`).run(process.platform,process.arch,at,at)
    old.db.prepare(`INSERT INTO agent_products(id,name) VALUES('pi','Pi')`).run()
    old.db.prepare(`INSERT INTO agent_installations(id,host_id,product_id,config_root,data_root,first_seen_at,last_seen_at) VALUES('i','h','pi',?,?,?,?)`).run(root,sessions,at,at)
    old.db.prepare(`INSERT INTO projects(id,name,created_at,last_seen_at) VALUES('p','M3 project',?,?)`).run(at,at)
    old.db.prepare(`INSERT INTO workspaces(id,host_id,project_id,path) VALUES('w','h','p',?)`).run(root)
    old.db.prepare(`INSERT INTO logical_sessions(id,installation_id,project_id,workspace_id,title,title_kind) VALUES('l','i','p','w','M3 title','explicit')`).run()
    old.db.prepare(`INSERT INTO source_sessions(id,source_id,installation_id,native_session_id,logical_session_id) VALUES('s','pi','i','m3-session','l')`).run()
    old.db.prepare(`INSERT INTO source_records(id,source_id,installation_id,source_session_native_id,native_type,captured_at,locator_json,payload_json,parser_version,fingerprint) VALUES('r','pi','i','m3-session','history/message',?,?,?,?,?)`).run(at,JSON.stringify({kind:'file',path:file,offset:Buffer.byteLength(header+'\n')}),event,piManifest.parserVersion,hash(event))
  }finally{await old.close()}
  const port=await freePort()
  const paths={legacyPath,backupPath:join(data,'backup.sqlite'),stagingPath:join(data,'stage.sqlite'),installedSlimPath:join(data,'installed.sqlite'),pointerPath:join(data,'active-database.json')}
  const env={...process.env,USERPROFILE:home,HOME:home,AGENT_LENS_DB_PATH:legacyPath,AGENT_LENS_ACTIVE_DB_POINTER:paths.pointerPath,
    AGENT_LENS_PORT:String(port),AGENT_LENS_ENABLED_SOURCES:'pi',AGENT_LENS_CAPTURE_POLICY_PATH:join(root,'policy.json'),
    AGENT_LENS_VAULT_PATH:join(root,'vault'),AGENT_LENS_INTEGRATIONS_DIR:join(root,'integrations'),AGENT_LENS_DISABLE_UPDATE_CHECK:'1'}
  return {root,home,data,file,paths,env,port}
}
function integrity(path:string){
  const d=new Database(path,{readonly:true,fileMustExist:true})
  try{assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[])}finally{d.close()}
}
async function prepare(f:Awaited<ReturnType<typeof fixture>>,maxPages=128,maxSessions=16){
  return prepareSlimCutover(['--legacy',f.paths.legacyPath,'--backup',f.paths.backupPath,'--staging',f.paths.stagingPath,'--limit',String(maxSessions),'--max-pages',String(maxPages)])
}
async function withPolicy<T>(run:()=>Promise<T>){
  const before=process.env.AGENT_LENS_ENABLED_SOURCES
  process.env.AGENT_LENS_ENABLED_SOURCES='pi'
  try{return await run()}finally{if(before===undefined)delete process.env.AGENT_LENS_ENABLED_SOURCES;else process.env.AGENT_LENS_ENABLED_SOURCES=before}
}

test('M3 分发 CLI：真实 v38 元数据与 Pi 原件迁移、默认 Daemon 读取、停机回滚',async()=>{
  const f=await fixture()
  try{
    const original=hash(await readFile(f.paths.legacyPath))
    const r=spawnSync(process.execPath,['dist/cli.mjs','migrate','--max-sessions','16','--max-pages','128'],{env:f.env,encoding:'utf8',timeout:60000})
    assert.equal(r.status,0,r.stdout+'\n'+r.stderr)
    const migrated=JSON.parse(r.stdout)
    assert.equal(migrated.state,'activated')
    assert.equal(hash(await readFile(f.paths.legacyPath)),original)
    assert.equal((await auditSlimCutoverFreshness({legacyPath:f.paths.legacyPath,
      backupPath:migrated.backupPath,stagingPath:migrated.slimPath})).unchangedSinceBackup,true)
    const slim=new Database(migrated.slimPath,{readonly:true})
    try{
      const tables=slim.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]
      for(const name of ['source_records','observations','evidence'])assert.ok(!tables.some(t=>t.name===name))
      assert.equal((slim.prepare('SELECT COUNT(*) AS n FROM native_session_catalog').get() as {n:number}).n,1)
      assert.equal((slim.prepare('SELECT input_tokens AS n FROM native_session_metrics').get() as {n:number}).n,10)
    }finally{slim.close()}
    const probe=`import assert from 'node:assert/strict';
      import {startDefaultDaemon} from ${JSON.stringify(pathToFileURL(resolve('dist/daemon.mjs')).href)};
      const running=await startDefaultDaemon();
      try {
        const base='http://127.0.0.1:'+running.http.port;
        const health=await (await fetch(base+'/api/v1/health')).json();
        assert.equal(health.storageMode,'native-only');assert.equal(health.storage.schemaVersion,1);
        const sessions=await (await fetch(base+'/api/v1/native-sessions')).json();
        const item=sessions.items.find(x=>x.nativeSessionId==='m3-session');assert.ok(item);assert.equal(item.projectId,'p');
        const response=await fetch(base+'/api/v1/native-sessions/'+item.id+'/review');assert.equal(response.status,200);
        const review=await response.json();assert.ok(JSON.stringify(review).includes('M3 验收输出'));
        console.log(JSON.stringify({health,session:item.id,reviewStatus:response.status}));
      }finally{await running.dispose()}`
    const read=spawnSync(process.execPath,['--input-type=module','-e',probe],{env:{...f.env,AGENT_LENS_PORT:'0'},encoding:'utf8',timeout:60000})
    assert.equal(read.status,0,read.stdout+'\n'+read.stderr)
    const rolled=await rollbackSlimCutover({...f.paths,backupPath:migrated.backupPath,installedSlimPath:migrated.slimPath,port:f.port})
    assert.equal(rolled.mode,'legacy')
    for(const path of [f.paths.legacyPath,migrated.backupPath,migrated.slimPath])integrity(path)
    assert.equal(hash(await readFile(f.paths.legacyPath)),original)
    const blocked=spawnSync(process.execPath,['dist/daemon.mjs'],{env:f.env,encoding:'utf8',timeout:20000})
    assert.equal(blocked.status,1);assert.match(blocked.stderr,/rolled back/)
  }finally{await rm(f.root,{recursive:true,force:true})}
})

test('M3 最终门禁：来源撤权、原件丢失/变更、归档、partial、旧库漂移均不发布指针',async t=>{
  await withPolicy(async()=>{
    for(const name of ['来源撤权','原件丢失','原件变更','归档-only','partial统计','旧库漂移','旧Writer活动','安装目标冲突','指针发布失败']){
      await t.test(name,async()=>{
        const f=await fixture()
        let writer:Database.Database|undefined
        try{
          const report=await prepare(f)
          assert.equal(report.metrics.complete,1)
          if(name==='来源撤权')process.env.AGENT_LENS_ENABLED_SOURCES='none'
          if(name==='原件丢失')await rename(f.file,f.file+'.missing')
          if(name==='原件变更')await writeFile(f.file,'changed\n')
          if(name==='旧库漂移'){
            const d=new Database(f.paths.legacyPath);d.exec('CREATE TABLE late_write(id INTEGER)');d.close()
          }
          if(name==='旧Writer活动'){writer=new Database(f.paths.legacyPath);writer.exec('BEGIN IMMEDIATE')}
          if(name==='归档-only'||name==='partial统计'){
            const d=new Database(f.paths.stagingPath)
            d.exec(name==='归档-only'?"UPDATE native_session_catalog SET location_kind='archive'":"UPDATE native_session_metrics SET coverage='partial'");d.close()
          }
          if(name==='安装目标冲突')await writeFile(f.paths.installedSlimPath,'existing destination')
          const paths=name==='指针发布失败'?{...f.paths,pointerPath:join(f.data,'absent','active.json')}:f.paths
          const oldHash=hash(await readFile(f.paths.legacyPath))
          const backupHash=hash(await readFile(f.paths.backupPath))
          const reason=name==='旧Writer活动'?/Legacy writer still holds/
            :name==='安装目标冲突'?/destination already exists/
            :name==='指针发布失败'?/ENOENT/
            :name==='旧库漂移'?/legacy-database-changed-since-snapshot/
            :name==='partial统计'?/native-metrics-partial-not-certified/
            :name==='归档-only'?/archived-only-sessions-not-deep-audited/
            :/original-session-content-unverified/
          await assert.rejects(finalizeSlimCutover(paths,f.port,{maxSessions:16,maxPages:128}),reason)
          assert.equal(await readActiveDatabasePointer(paths.pointerPath),null)
          if(name==='安装目标冲突')assert.equal(await readFile(f.paths.installedSlimPath,'utf8'),'existing destination')
          else await assert.rejects(readFile(f.paths.installedSlimPath),/ENOENT/)
          integrity(f.paths.legacyPath);integrity(f.paths.backupPath)
          assert.equal(hash(await readFile(f.paths.legacyPath)),oldHash)
          assert.equal(hash(await readFile(f.paths.backupPath)),backupHash)
        }finally{
          if(writer){writer.exec('ROLLBACK');writer.close()}
          process.env.AGENT_LENS_ENABLED_SOURCES='pi'
          await rm(f.root,{recursive:true,force:true})
        }
      })
    }
  })
})

test('M3 准备：真实 Pi 超页预算、来源撤权、未迁移 v38 启动阻断',async t=>{
  await withPolicy(async()=>{
    for(const name of ['超页预算','超会话预算','原生partial','来源撤权','未迁移v38'])await t.test(name,async()=>{
      const f=await fixture()
      try{
        const bytes=hash(await readFile(f.paths.legacyPath))
        if(name==='未迁移v38'){
          const r=spawnSync(process.execPath,['dist/daemon.mjs'],{env:f.env,encoding:'utf8',timeout:20000})
          assert.equal(r.status,1);assert.match(r.stderr,/old v38 Writer is retired/)
        }else{
          if(name==='超页预算'){
            const messages=Array.from({length:100},(_,i)=>JSON.stringify({type:'message',id:'u'+i,timestamp:at,message:{role:'user',content:'budget'}}))
            await writeFile(f.file,(await readFile(f.file,'utf8'))+messages.join('\n')+'\n')
          }else if(name==='超会话预算'){
            const original=await readFile(f.file,'utf8')
            await writeFile(join(f.root,'sessions','second.jsonl'),original.replaceAll('m3-session','second-session'))
          }else if(name==='原生partial'){
            await writeFile(f.file,(await readFile(f.file,'utf8'))+'{"type":')
          }else process.env.AGENT_LENS_ENABLED_SOURCES='none'
          const report=await prepare(f,1,name==='超会话预算'?1:16)
          assert.ok(report.blockedBy.some(x=>/budget|incomplete|disabled|unverified/.test(x)),JSON.stringify(report))
          assert.equal(report.readyToSwitch,false)
        }
        assert.equal(await readActiveDatabasePointer(f.paths.pointerPath),null)
        assert.equal(hash(await readFile(f.paths.legacyPath)),bytes)
      }finally{process.env.AGENT_LENS_ENABLED_SOURCES='pi';await rm(f.root,{recursive:true,force:true})}
    })
  })
})

test('M3 跨入口：CLI 和桌面同协议旧 Daemon 拒绝复用',async()=>{
  const f=await fixture()
  const oldHealth={status:'ok',protocolVersion:'1.0',storage:{ok:true,schemaVersion:38}}
  const server=createHttpServer((_request,response)=>{
    response.setHeader('content-type','application/json')
    response.end(JSON.stringify(oldHealth))
  })
  try{
    await new Promise<void>(done=>server.listen(f.port,'127.0.0.1',done))
    const result=await new Promise<{code:number|null;text:string}>((done,fail)=>{
      const child=spawn(process.execPath,['dist/cli.mjs','start'],{env:f.env,stdio:['ignore','pipe','pipe']})
      let text=''
      const timeout=setTimeout(()=>{child.kill();fail(new Error('CLI 旧 Daemon 拒绝检查超时'))},20000)
      child.stdout.on('data',data=>{text+=data});child.stderr.on('data',data=>{text+=data})
      child.once('error',error=>{clearTimeout(timeout);fail(error)})
      child.once('exit',code=>{clearTimeout(timeout);done({code,text})})
    })
    assert.equal(result.code,1)
    assert.match(result.text,/旧版 AgentLens|不兼容/)
    // 执行桌面入口本身的纯校验函数，无需启动 Electron 或用户桌面服务。
    const desktop=await readFile(resolve('apps/desktop/src/main.mjs'),'utf8')
    const start=desktop.indexOf('function assertCompatibleDaemon(')
    const end=desktop.indexOf('\nfunction ',start+1)
    assert.ok(start>=0&&end>start)
    const guard=runInNewContext(desktop.slice(start,end)+'\nassertCompatibleDaemon',{
      EXPECTED_PROTOCOL_VERSION:'1.0',
    }) as (health:unknown)=>void
    assert.throws(()=>guard(oldHealth),/旧版 AgentLens/)
    assert.doesNotThrow(()=>guard({protocolVersion:'1.0',storageMode:'native-only',
      storage:{details:{schemaKind:'slim-native-session-v1'}}}))
    assert.ok(desktop.includes("unpackedAsset('runtime', 'daemon.mjs')"))
  }finally{
    await new Promise<void>(done=>server.close(()=>done()))
    await rm(f.root,{recursive:true,force:true})
  }
})
