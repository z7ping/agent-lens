import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { isAbsolute, resolve } from 'node:path'
import type { AgentWorkMutationDto } from '@agent-lens/protocol'
import { verifyHermesWorkMutation, type NativeMutationVerification } from './workspace-action-verification.js'

const execFileAsync = promisify(execFile)
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const TASK_ID=/^[a-zA-Z0-9_-]{1,128}$/
const MAX_OUTPUT=16*1024
const required=(value:unknown,limit:number,label:string):string=>{
  if(typeof value!=='string'||!value.trim()||value.length>limit||value.includes('\0')) throw new Error('Invalid '+label)
  return value.trim()
}
const identity=(value:unknown,label:string,rule=ID):string=>{
  const s=required(value,128,label)
  if(!rule.test(s)||s.startsWith('-'))throw new Error('Invalid '+label)
  return s
}
const field=(value:unknown,label:string,limit=4000):string|undefined=>
  value===undefined?undefined:required(value,limit,label)
const optionalPriority=(value:unknown):number|undefined=>{
  if(value===undefined)return undefined
  if(!Number.isSafeInteger(value)||Number(value)<-100000||Number(value)>100000)throw new Error('Invalid priority')
  return Number(value)
}
const append=(args:string[],flag:string,value:string|number|undefined)=>{
  if(value!==undefined)args.push(flag,String(value))
}

/** Map only allowlisted Hermes native verbs to argv. Never invoke a shell. */
export function hermesWorkMutationArgv(action:AgentWorkMutationDto):string[] {
  if(!action || typeof action!=='object')throw new Error('Invalid mutation')
  const a=action
  if(typeof a.kind!=='string')throw new Error('Mutation kind is required')
  if(a.kind.startsWith('board.')){
    if(!('slug' in a))throw new Error('Board slug is required')
    const slug=identity(a.slug,'board')
    switch(a.kind){
      case 'board.create':return ['kanban','boards','create',slug,
        ...(a.name?['--name',required(a.name,180,'board name')]:[])]
      case 'board.rename':return ['kanban','boards','rename',slug,required(a.name,180,'board name')]
      case 'board.archive':return ['kanban','boards','rm',slug]
    }
  }
  if(a.kind.startsWith('task.')){
    if(!('boardId' in a))throw new Error('Board identity is required')
    const argv=['kanban','--board',identity(a.boardId,'board')]
    switch(a.kind){
      case 'task.create': {
        argv.push('create',required(a.title,180,'task title'))
        append(argv,'--body',field(a.body,'task body'))
        append(argv,'--assignee',a.assignee===undefined?undefined:identity(a.assignee,'assignee'))
        append(argv,'--priority',optionalPriority(a.priority))
        return argv
      }
      case 'task.edit': {
        const title=field(a.title,'task title',180),body=field(a.body,'task body')
        const priority=optionalPriority(a.priority)
        if(title===undefined&&body===undefined&&priority===undefined)throw new Error('No task changes')
        argv.push('edit',identity(a.taskId,'task',TASK_ID))
        append(argv,'--title',title);append(argv,'--body',body);append(argv,'--priority',priority)
        return argv
      }
      case 'task.assign':
        return [...argv,'assign',identity(a.taskId,'task',TASK_ID),identity(a.profile,'profile')]
      case 'task.link':
      case 'task.unlink': {
        const parent=identity(a.parentId,'parent',TASK_ID),child=identity(a.childId,'child',TASK_ID)
        if(parent===child)throw new Error('Task cannot depend on itself')
        return [...argv,a.kind==='task.link'?'link':'unlink',parent,child]
      }
      case 'task.archive':return [...argv,'archive',identity(a.taskId,'task',TASK_ID)]
      case 'task.block':return [...argv,'block',identity(a.taskId,'task',TASK_ID),...(a.reason?[required(a.reason,400,'reason')]:[])]
      case 'task.unblock':return [...argv,'unblock',identity(a.taskId,'task',TASK_ID),...(a.reason?['--reason',required(a.reason,400,'reason')]:[])]
      case 'task.complete':return [...argv,'complete',identity(a.taskId,'task',TASK_ID),...(a.reason?['--result',required(a.reason,400,'result')]:[])]
      case 'task.promote':return [...argv,'promote',identity(a.taskId,'task',TASK_ID),...(a.reason?[required(a.reason,400,'reason')]:[])]
    }
  }
  if(a.kind.startsWith('cron.')){
    if(!('profile' in a))throw new Error('Cron profile is required')
    const argv=['--profile',identity(a.profile,'profile'),'cron']
    switch(a.kind){
      case 'cron.create':{
        const schedule=required(a.schedule,180,'schedule'),prompt=required(a.prompt,4000,'prompt')
        argv.push('create',schedule,prompt)
        append(argv,'--name',field(a.name,'name',180))
        return argv
      }
      case 'cron.edit':{
        const schedule=field(a.schedule,'schedule',180),prompt=field(a.prompt,'prompt'),name=field(a.name,'name',180)
        if(schedule===undefined&&prompt===undefined&&name===undefined)throw new Error('No Cron changes')
        argv.push('edit',identity(a.jobId,'job',TASK_ID))
        append(argv,'--schedule',schedule);append(argv,'--prompt',prompt);append(argv,'--name',name)
        return argv
      }
      case 'cron.run':
      case 'cron.pause':
      case 'cron.resume':
      case 'cron.remove':
      case 'cron.cancel':
        return [...argv,a.kind.slice('cron.'.length),identity(a.jobId,'job',TASK_ID)]
    }
  }
  throw new Error('Unsupported Hermes work mutation')
}

type CronDispatchReceipt = {
  id:string
  root:string
  sourceId:string
  installationId:string
  profile:string
  jobId:string
  status:'running'|'accepted'|'failed'|'unknown'
  message:string
  updatedAt:number
}
const dispatchReceipts=new Map<string,CronDispatchReceipt>()
const activeDispatches=new Map<string,string>()
const MAX_ACTIVE_DISPATCHES=8
const MAX_RECEIPTS=200
const RECEIPT_TTL=30*60*1000

function pruneDispatchReceipts():void {
  const now=Date.now()
  for(const [id,item] of dispatchReceipts) {
    if(item.status!=='running' && now-item.updatedAt>RECEIPT_TTL)dispatchReceipts.delete(id)
  }
  if(dispatchReceipts.size<=MAX_RECEIPTS)return
  for(const [id,item] of dispatchReceipts) {
    if(dispatchReceipts.size<=MAX_RECEIPTS)break
    if(item.status!=='running')dispatchReceipts.delete(id)
  }
}

/** A receipt is a CLI handoff acknowledgement, NEVER the native job execution result. */
export function readHermesCronRunReceipt(options:{roots:string[];sourceId:string;installationId:string;receiptId:string}):{
  receiptId:string
  status:CronDispatchReceipt['status']
  message:string
}|null {
  if(options.roots.length!==1 || !isAbsolute(options.roots[0]??''))return null
  pruneDispatchReceipts()
  const receipt=dispatchReceipts.get(options.receiptId)
  if(!receipt || receipt.root!==resolve(options.roots[0]!)
    || receipt.sourceId!==options.sourceId || receipt.installationId!==options.installationId)return null
  return {receiptId:receipt.id,status:receipt.status,message:receipt.message}
}

async function dispatchHermesCronRun(options:{
  sourceId:string
  installationId:string
  root:string
  executable:string
  env:NodeJS.ProcessEnv
  profile:string
  jobId:string
}):Promise<{accepted:boolean;pending?:boolean;receiptId?:string;message:string}> {
  pruneDispatchReceipts()
  const key=JSON.stringify([options.sourceId,options.installationId,options.root,options.profile,options.jobId])
  const duplicateId=activeDispatches.get(key)
  if(duplicateId){
    return {accepted:false,pending:true,receiptId:duplicateId,
      message:'Hermes Cron run is already being dispatched; check its receipt before retrying.'}
  }
  if(activeDispatches.size>=MAX_ACTIVE_DISPATCHES){
    return {accepted:false,message:'Too many Hermes Cron CLI runs are pending.'}
  }
  const receipt:CronDispatchReceipt={
    id:randomUUID(),root:options.root,sourceId:options.sourceId,
    installationId:options.installationId,profile:options.profile,jobId:options.jobId,
    status:'running',message:'Hermes Cron CLI is running; native execution is not yet confirmed.',
    updatedAt:Date.now(),
  }
  dispatchReceipts.set(receipt.id,receipt)
  activeDispatches.set(key,receipt.id)
  let child
  try {
    // The upstream CLI may synchronously execute the entire Agent. Do not hold
    // the HTTP request open or build a replacement Cron scheduler.
    child=spawn(options.executable,['--profile',options.profile,'cron','run',options.jobId],{
      cwd:options.root,env:options.env,windowsHide:true,detached:true,
      shell:false,stdio:'ignore',
    })
  }catch(error){
    activeDispatches.delete(key)
    receipt.status='failed'
    receipt.message='Could not start Hermes CLI: '+String(error).slice(0,500)
    receipt.updatedAt=Date.now()
    return {accepted:false,message:receipt.message}
  }
  child.once('close',(code,signal)=>{
    activeDispatches.delete(key)
    if(receipt.status==='failed')return
    receipt.status=code===0?'accepted':code===null?'unknown':'failed'
    receipt.message=code===0
      ?'Hermes CLI exited successfully. Refresh native execution history to verify the outcome.'
      :code===null
        ?'Hermes CLI exited without a known result ('+(signal??'unknown')+'); check native history.'
        :'Hermes Cron CLI exited with code '+code+'. Check native history before retrying.'
    receipt.updatedAt=Date.now()
  })
  const started=await new Promise<boolean>(resolveStart=>{
    child.once('spawn',()=>resolveStart(true))
    child.once('error',error=>{
      receipt.status='failed'
      receipt.message='Hermes CLI failed to start: '+error.message.slice(0,500)
      receipt.updatedAt=Date.now()
      activeDispatches.delete(key)
      resolveStart(false)
    })
  })
  if(!started)return {accepted:false,message:receipt.message}
  child.unref()
  return {accepted:false,pending:true,receiptId:receipt.id,
    message:'Hermes Cron CLI started. Follow the receipt and native execution history.'}
}

export async function mutateHermesWorkspace(options:{
  sourceId:string
  installationId:string
  roots:string[]
  action:AgentWorkMutationDto
  executable?:string
}):Promise<{accepted:boolean;pending?:boolean;receiptId?:string;message:string}&Partial<NativeMutationVerification>>{
  if(options.sourceId!=='hermes'||!options.installationId)throw new Error('Verified Hermes scope is required')
  if(options.roots.length!==1||!isAbsolute(options.roots[0]??''))throw new Error('Verified Hermes installation root is required')
  const root=resolve(options.roots[0]!)
  let args:string[]
  try{args=hermesWorkMutationArgv(options.action)}
  catch(error){return {accepted:false,message:error instanceof Error?error.message:'Invalid Hermes action'}}
  // Hermes itself owns locking, migrations and native persistence.
  // Keep the inherited environment except for HOME routing and nested worker context.
  const env: NodeJS.ProcessEnv={...process.env,HERMES_HOME:root}
  delete env.HERMES_KANBAN_TASK
  delete env.HERMES_KANBAN_RUN_ID
  delete env.HERMES_KANBAN_BOARD
  delete env.HERMES_SESSION_KEY
  const executable=options.executable??'hermes'
  if(executable.includes('\0'))throw new Error('Invalid Hermes executable')
  if(options.action.kind==='cron.run') {
    return dispatchHermesCronRun({root,executable,env,
      sourceId:options.sourceId,installationId:options.installationId,
      profile:identity(options.action.profile,'profile'),
      jobId:identity(options.action.jobId,'job',TASK_ID)})
  }
  let message:string
  try{
    const {stdout,stderr}=await execFileAsync(executable,args,{
      cwd:root,env,encoding:'utf8',timeout:20_000,maxBuffer:MAX_OUTPUT,windowsHide:true,
      shell:false,
    })
    message=(stdout||stderr||'Hermes accepted the operation').trim().slice(0,2000)
  }catch(e){
    const error=e as Error&{stderr?:string;stdout?:string;code?:string|number;killed?:boolean}
    // A timeout may have changed native data. Never imply a definite failure.
    return {accepted:false,message:error.killed
      ? 'Hermes operation timed out; the outcome is unknown. Refresh before retrying.'
      : 'Hermes operation failed: '+(error.stderr||error.message||'unknown error').slice(0,1800)}
  }
  // A read-back failure must not retroactively change a successful CLI exit into failure.
  let verification:NativeMutationVerification
  try{
    verification=await verifyHermesWorkMutation(root,options.action)
  }catch{
    verification={verification:'unconfirmed',verificationMessage:'Native read-back failed. Refresh to confirm.'}
  }
  return {accepted:true,message,...verification}
}
