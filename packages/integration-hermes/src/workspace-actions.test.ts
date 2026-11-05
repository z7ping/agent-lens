import assert from 'node:assert/strict'
import test from 'node:test'
import { hermesWorkMutationArgv, mutateHermesWorkspace, readHermesCronRunReceipt } from './workspace-actions.js'

test('Hermes task commands pin an explicit board without a shell',()=>{
  assert.deepEqual(hermesWorkMutationArgv({kind:'task.create',boardId:'team',title:'Review API',priority:2}),
    ['kanban','--board','team','create','Review API','--priority','2'])
  assert.deepEqual(hermesWorkMutationArgv({kind:'task.edit',boardId:'team',taskId:'task_1',title:'Fix',priority:0}),
    ['kanban','--board','team','edit','task_1','--title','Fix','--priority','0'])
  assert.deepEqual(hermesWorkMutationArgv({kind:'task.link',boardId:'team',parentId:'a',childId:'b'}),
    ['kanban','--board','team','link','a','b'])
  assert.deepEqual(hermesWorkMutationArgv({kind:'task.unblock',boardId:'default',taskId:'abc'}),
    ['kanban','--board','default','unblock','abc'])
})

test('Hermes Cron commands pin the correct native profile',()=>{
  assert.deepEqual(hermesWorkMutationArgv({kind:'cron.pause',profile:'coder',jobId:'job-1'}),
    ['--profile','coder','cron','pause','job-1'])
  assert.deepEqual(hermesWorkMutationArgv({kind:'cron.run',profile:'coder',jobId:'job-1'}),
    ['--profile','coder','cron','run','job-1'])
  assert.deepEqual(hermesWorkMutationArgv({kind:'cron.create',profile:'default',schedule:'0 9 * * *',prompt:'Summarize',name:'Morning'}),
    ['--profile','default','cron','create','0 9 * * *','Summarize','--name','Morning'])
})

test('Hermes mutations reject ambiguous identity, injection and no-op input',()=>{
  assert.throws(()=>hermesWorkMutationArgv({kind:'cron.resume',profile:'../other',jobId:'j'}),/Invalid profile/)
  assert.throws(()=>hermesWorkMutationArgv({kind:'task.archive',boardId:'../secret',taskId:'t'}),/Invalid board/)
  assert.throws(()=>hermesWorkMutationArgv({kind:'task.edit',boardId:'default',taskId:'t'}),/No task changes/)
  assert.throws(()=>hermesWorkMutationArgv({kind:'task.link',boardId:'default',parentId:'t',childId:'t'}),/depend on itself/)
  assert.throws(()=>hermesWorkMutationArgv({kind:'cron.create',profile:'default',schedule:'',prompt:'one'}),/Invalid schedule/)
})


test('manual Hermes Cron CLI runs require an exact native job and profile',()=>{
  assert.throws(()=>hermesWorkMutationArgv({kind:'cron.run',profile:'../../escape',jobId:'job-1'}),/Invalid profile/)
  assert.throws(()=>hermesWorkMutationArgv({kind:'cron.run',profile:'default',jobId:'--all'}),/Invalid job/)
})

test('manual Cron dispatch returns a scoped receipt without awaiting the native worker',async()=>{
  // Node rejects Hermes CLI arguments, so this exercises spawn/exit/receipt
  // without needing a real Hermes installation or creating a scheduled job.
  const action={kind:'cron.run',profile:'default',jobId:'demo-job'} as const
  const result=await mutateHermesWorkspace({
    sourceId:'hermes',installationId:'install-a',roots:[process.cwd()],
    executable:process.execPath,action,
  })
  assert.equal(result.pending,true)
  assert.equal(result.accepted,false,'spawn is not a successful Hermes execution')
  assert.ok(result.receiptId)
  const scope={sourceId:'hermes',installationId:'install-a',roots:[process.cwd()],receiptId:result.receiptId!}
  assert.equal(readHermesCronRunReceipt({...scope,installationId:'other'}),null)
  assert.equal(readHermesCronRunReceipt({...scope,sourceId:'other'}),null)
  for(let i=0;i<40;i++){
    const receipt=readHermesCronRunReceipt(scope)
    assert.ok(receipt)
    if(receipt.status!=='running'){
      assert.equal(receipt.status,'failed')
      return
    }
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  assert.fail('Expected a CLI exit receipt')
})
