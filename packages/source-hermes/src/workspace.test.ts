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
      mkdir(join(profileRoot,'cron'),{recursive:true})])
    const database = (path:string) => new DatabaseSync(path)
    const createBoard=(path:string,id:string,title:string)=>{
      const db=database(path)
      db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,status TEXT,assignee TEXT,project_id TEXT,priority INTEGER,created_at INTEGER,last_failure_error TEXT,current_run_id INTEGER)')
      db.exec('CREATE TABLE task_runs (id INTEGER PRIMARY KEY,task_id TEXT,profile TEXT,status TEXT,outcome TEXT,started_at INTEGER,ended_at INTEGER,summary TEXT,error TEXT)')
      db.prepare('INSERT INTO tasks (id,title,status,priority,created_at) VALUES (?,?,?,?,?)')
        .run(id,title,'ready',1,1730000000)
      db.prepare('INSERT INTO task_runs (id,task_id,profile,status,started_at,summary) VALUES (?,?,?,?,?,?)')
        .run(1,id,'coder','done',1730000000,'Finished')
      db.close()
    }
    createBoard(join(root,'kanban.db'),'t1','Default task')
    createBoard(join(boardRoot,'kanban.db'),'t2','Team task')
    await writeFile(join(boardRoot,'board.json'),JSON.stringify({name:'Team board',project_id:'project-1'}))
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
    const response=await readHermesWorkspace({roots:[root],board:'team',limit:1})
    assert.deepEqual(response.features.map(f=>f.availability),['available','available'])
    assert.equal(response.boards.length,2)
    assert.equal(response.boards.find(b=>b.id==='team')?.name,'Team board')
    assert.equal(response.tasks[0]?.id,'t2')
    assert.equal(response.runs[0]?.taskId,'t2')
    assert.equal(response.schedules.length,2)
    assert.equal(response.schedules.find(j=>j.profile==='default')?.noAgent,true)
    assert.equal(response.executions[0]?.profile,'coder')
    assert.equal(response.projects[0]?.profile,'coder')
    assert.deepEqual(await readFile(join(root,'cron','jobs.json')),before)
  } finally {await rm(root,{recursive:true,force:true})}
})
test('Hermes workspace missing roots remain unknown, not zero or unsupported',async()=>{
  const root=join(tmpdir(),'agentlens-nonexistent-work-1009')
  const data=await readHermesWorkspace({roots:[root]})
  assert.deepEqual(data.features.map(item=>item.availability),['unknown','unknown'])
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
