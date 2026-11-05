import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { verifyHermesWorkMutation } from './workspace-action-verification.js'

test('native read-back proves only exact task, board and Cron fields',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hermes-work-verify-'))
  try{
    const db=new DatabaseSync(join(root,'kanban.db'))
    db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,status TEXT,assignee TEXT,priority INTEGER,created_at INTEGER)')
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run('t1','Updated title','done','coder',2,1730000000)
    db.close()
    await mkdir(join(root,'kanban','boards','default'),{recursive:true})
    await writeFile(join(root,'kanban','boards','default','board.json'),JSON.stringify({name:'My board'}))
    await mkdir(join(root,'cron'),{recursive:true})
    await writeFile(join(root,'cron','jobs.json'),JSON.stringify({jobs:[
      {id:'j1',profile:'default',name:'Morning',enabled:false,schedule_display:'every 1h'},
    ]}))
    const check=(action:Parameters<typeof verifyHermesWorkMutation>[1])=>verifyHermesWorkMutation(root,action)
    assert.equal((await check({kind:'board.rename',slug:'default',name:'My board'})).verification,'confirmed')
    assert.equal((await check({kind:'task.complete',boardId:'default',taskId:'t1'})).verification,'confirmed')
    assert.equal((await check({kind:'task.assign',boardId:'default',taskId:'t1',profile:'coder'})).verification,'confirmed')
    assert.equal((await check({kind:'task.edit',boardId:'default',taskId:'t1',title:'Different'})).verification,'unconfirmed')
    assert.equal((await check({kind:'task.edit',boardId:'default',taskId:'t1',body:'Not surfaced'})).verification,'unconfirmed')
    assert.equal((await check({kind:'cron.pause',profile:'default',jobId:'j1'})).verification,'confirmed')
    assert.equal((await check({kind:'cron.resume',profile:'default',jobId:'j1'})).verification,'unconfirmed')
    assert.equal((await check({kind:'cron.edit',profile:'default',jobId:'j1',prompt:'Not surfaced'})).verification,'not-verifiable')
    assert.equal((await check({kind:'task.create',boardId:'default',title:'New'})).verification,'not-verifiable')
    assert.equal((await check({kind:'cron.run',profile:'default',jobId:'j1'})).verification,'not-verifiable')
  }finally{await rm(root,{recursive:true,force:true})}
})
