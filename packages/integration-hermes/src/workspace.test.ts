import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readHermesWorkspace } from './workspace.js'

test('Hermes workspace reads multiple boards and profile-local scheduled work without modifying originals', async () => {
  const root = await mkdtemp(join(tmpdir(),'agentlens-hermes-work-'))
  try {
    const boardRoot=join(root,'kanban','boards','team')
    const profileRoot=join(root,'profiles','coder')
    await Promise.all([mkdir(boardRoot,{recursive:true}),mkdir(join(root,'cron'),{recursive:true}),
      mkdir(join(profileRoot,'cron'),{recursive:true}),
      mkdir(join(root,'kanban','boards','default'),{recursive:true})])
    const database = (path:string) => new DatabaseSync(path)
    const createBoard=(path:string,id:string,title:string)=>{
      const db=database(path)
      db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,status TEXT,assignee TEXT,project_id TEXT,priority INTEGER,created_at INTEGER,last_failure_error TEXT,current_run_id INTEGER,session_id TEXT)')
      db.exec('CREATE TABLE task_runs (id INTEGER PRIMARY KEY,task_id TEXT,profile TEXT,status TEXT,outcome TEXT,started_at INTEGER,ended_at INTEGER,summary TEXT,error TEXT)')
      db.prepare('INSERT INTO tasks (id,title,status,priority,created_at) VALUES (?,?,?,?,?)')
        .run(id,title,'ready',1,1730000000)
      db.prepare('INSERT INTO task_runs (id,task_id,profile,status,started_at,summary) VALUES (?,?,?,?,?,?)')
        .run(1,id,'coder','done',1730000000,'Finished')
      db.close()
    }
    createBoard(join(root,'kanban.db'),'t1','Default task')
    createBoard(join(boardRoot,'kanban.db'),'t2','Team task')
    const native=new DatabaseSync(join(boardRoot,'kanban.db'))
    native.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run('native-session-123','t2')
    native.close()
    const detailsDb=new DatabaseSync(join(boardRoot,'kanban.db'))
    detailsDb.exec('CREATE TABLE task_links (parent_id TEXT,child_id TEXT)')
    detailsDb.exec('CREATE TABLE task_comments (id INTEGER PRIMARY KEY,task_id TEXT,author TEXT,body TEXT,created_at INTEGER)')
    detailsDb.exec('CREATE TABLE task_events (id INTEGER PRIMARY KEY,task_id TEXT,kind TEXT,run_id INTEGER,created_at INTEGER,payload TEXT)')
    detailsDb.prepare('INSERT INTO task_links VALUES (?,?)').run('t1','t2')
    detailsDb.prepare('INSERT INTO task_comments VALUES (?,?,?,?,?)').run(1,'t2','coder','reviewed',1730000000)
    detailsDb.prepare('INSERT INTO task_events VALUES (?,?,?,?,?,?)').run(1,'t2','claimed',1,1730000000,null)
    detailsDb.prepare('INSERT INTO task_events VALUES (?,?,?,?,?,?)').run(2,'t2','owner_admitted',1,1730000001,JSON.stringify({session_id:'worker-native-1'}))
    detailsDb.close()
    await writeFile(join(boardRoot,'board.json'),JSON.stringify({name:'Team board',project_id:'project-1'}))
    await writeFile(join(root,'kanban','boards','default','board.json'),JSON.stringify({name:'Personal board'}))
    await mkdir(join(root,'kanban','boards','orphan'),{recursive:true})
    createBoard(join(root,'kanban','boards','orphan','kanban.db'),'ghost','Ghost task')
    await writeFile(join(root,'cron','jobs.json'),JSON.stringify({jobs:[{
      id:'job1',name:'daily',enabled:true,schedule_display:'0 8 * * *',no_agent:true,
      next_run_at:'2026-11-04T08:00:00+08:00'
    }]}))
    await writeFile(join(profileRoot,'cron','jobs.json'),JSON.stringify({jobs:[{
      id:'job2',name:'review',enabled:false,state:'paused',schedule_display:'every 1h'
    }]}))
    const cronDb=database(join(profileRoot,'cron','executions.db'))
    cronDb.exec('CREATE TABLE executions (id TEXT PRIMARY KEY,job_id TEXT,status TEXT,claimed_at TEXT,started_at TEXT,finished_at TEXT,error TEXT,delivery_outcome TEXT)')
    cronDb.prepare('INSERT INTO executions (id,job_id,status,claimed_at,delivery_outcome) VALUES (?,?,?,?,?)')
      .run('exec1','job2','completed','2026-11-01T01:00:00Z','delivered')
    cronDb.close()
    const projects=database(join(profileRoot,'projects.db'))
    projects.exec('CREATE TABLE projects (id TEXT PRIMARY KEY,slug TEXT,name TEXT,archived INTEGER,board_slug TEXT,primary_path TEXT)')
    projects.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?)').run('project-1','repo','Repo',0,'team','/repo')
    projects.close()
    const before=await readFile(join(root,'cron','jobs.json'))
    const response=await readHermesWorkspace({roots:[root],board:'team',limit:1,jobId:'job2',profile:'coder',taskId:'t2'})
    assert.deepEqual(response.features.map(f=>f.availability),['available','available','available'])
    assert.equal(response.boards.length,2)
    assert.equal(response.boards.find(b=>b.id==='default')?.name,'Personal board')
    assert.equal(response.boards.some(b=>b.id==='orphan'),false)
    assert.equal(response.boards.find(b=>b.id==='team')?.name,'Team board')
    assert.equal(response.tasks[0]?.id,'t2')
    assert.equal(response.tasks[0]?.sourceSessionNativeId,'native-session-123')
    assert.equal(response.runs[0]?.taskId,'t2')
    assert.equal(response.runs[0]?.workerSessionNativeId,'worker-native-1')
    assert.equal(response.schedules.length,2)
    assert.equal(response.schedules.find(j=>j.profile==='default')?.noAgent,true)
    assert.equal(response.executions[0]?.profile,'coder')
    assert.equal(response.projects[0]?.profile,'coder')
    assert.equal(response.taskLinks[0]?.parentId,'t1')
    assert.equal(response.taskComments[0]?.author,'coder')
    assert.equal(response.taskEvents[0]?.kind,'claimed')
    assert.deepEqual(await readFile(join(root,'cron','jobs.json')),before)
  } finally {await rm(root,{recursive:true,force:true})}
})
test('Hermes workspace missing roots remain unknown, not zero or unsupported',async()=>{
  const root=join(tmpdir(),'agentlens-nonexistent-work-1009')
  const data=await readHermesWorkspace({roots:[root]})
  assert.deepEqual(data.features.map(item=>item.availability),['unknown','unknown','unknown'])
  assert.deepEqual(data.boards,[])
  assert.deepEqual(data.schedules,[])
})
test('Hermes bad Cron data does not hide an otherwise healthy Board',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentlens-work-partial-'))
  try{
    const db=new DatabaseSync(join(root,'kanban.db'))
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,status TEXT,created_at INTEGER)')
    db.close()
    await mkdir(join(root,'cron'))
    await writeFile(join(root,'cron','jobs.json'),'{not-json')
    const data=await readHermesWorkspace({roots:[root]})
    assert.equal(data.features[0]?.availability,'available')
    assert.equal(data.features[1]?.availability,'error')
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Task runs, comments and events can be browsed past their first page without cross-task records',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentlens-hermes-task-pages-'))
  try{
    const db=new DatabaseSync(join(root,'kanban.db'))
    db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,status TEXT,created_at INTEGER)')
    db.exec('CREATE TABLE task_runs(id INTEGER PRIMARY KEY,task_id TEXT,status TEXT,started_at INTEGER)')
    db.exec('CREATE TABLE task_comments(id INTEGER PRIMARY KEY,task_id TEXT,author TEXT,body TEXT,created_at INTEGER)')
    db.exec('CREATE TABLE task_events(id INTEGER PRIMARY KEY,task_id TEXT,kind TEXT,created_at INTEGER)')
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run('t1','Task','ready',1730000000)
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run('t2','Other','done',1730000001)
    for(let i=1;i<=205;i++){
      db.prepare('INSERT INTO task_runs VALUES (?,?,?,?)').run(i,'t1','done',1730000000+i)
      if(i<=101){
        db.prepare('INSERT INTO task_comments VALUES (?,?,?,?,?)').run(i,'t1','worker','message',1730000000+i)
      }
      if(i<=202){
        db.prepare('INSERT INTO task_events VALUES (?,?,?,?)').run(i,'t1','updated',1730000000+i)
      }
    }
    db.prepare('INSERT INTO task_runs VALUES (?,?,?,?)').run(999,'t2','failed',1739999999)
    db.close()
    const first=await readHermesWorkspace({roots:[root],board:'default',taskId:'t1'})
    assert.equal(first.runs.length,100)
    assert.equal(first.runsHasMore,true)
    assert.equal(first.taskComments.length,50)
    assert.equal(first.taskCommentsHasMore,true)
    assert.equal(first.taskEvents.length,100)
    assert.equal(first.taskEventsHasMore,true)
    assert.equal(first.runs.every(item=>item.taskId==='t1'),true)
    const tail=await readHermesWorkspace({roots:[root],board:'default',taskId:'t1',
      runOffset:200,commentOffset:100,taskEventOffset:200})
    assert.equal(tail.runs.length,5)
    assert.equal(tail.runsHasMore,false)
    assert.equal(tail.taskComments.length,1)
    assert.equal(tail.taskCommentsHasMore,false)
    assert.equal(tail.taskEvents.length,2)
    assert.equal(tail.taskEventsHasMore,false)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('conflicting owner-admission receipts never produce a worker-session link',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentlens-hermes-owner-conflict-'))
  try {
    const db=new DatabaseSync(join(root,'kanban.db'))
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,status TEXT,created_at INTEGER)')
    db.exec('CREATE TABLE task_runs (id INTEGER PRIMARY KEY,task_id TEXT,status TEXT,started_at INTEGER)')
    db.exec('CREATE TABLE task_events (id INTEGER PRIMARY KEY,task_id TEXT,run_id INTEGER,kind TEXT,payload TEXT)')
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run('t1','Task','done',1730000000)
    db.prepare('INSERT INTO task_runs VALUES (?,?,?,?)').run(1,'t1','done',1730000001)
    db.prepare('INSERT INTO task_events VALUES (?,?,?,?,?)').run(1,'t1',1,'owner_admitted',JSON.stringify({session_id:'worker-one'}))
    db.prepare('INSERT INTO task_events VALUES (?,?,?,?,?)').run(2,'t1',1,'owner_admitted',JSON.stringify({session_id:'worker-two'}))
    db.close()
    const result=await readHermesWorkspace({roots:[root],board:'default',taskId:'t1'})
    assert.equal(result.runs.length,1)
    assert.equal(result.runs[0]?.workerSessionNativeId,undefined)
  }finally{await rm(root,{recursive:true,force:true})}
})
