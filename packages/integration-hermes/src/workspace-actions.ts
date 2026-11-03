import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, resolve } from 'node:path'
import type { AgentWorkMutationDto } from '@agent-lens/protocol'

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
      case 'cron.pause':
      case 'cron.resume':
      case 'cron.remove':
      case 'cron.cancel':
        return [...argv,a.kind.slice('cron.'.length),identity(a.jobId,'job',TASK_ID)]
    }
  }
  throw new Error('Unsupported Hermes work mutation')
}

export async function mutateHermesWorkspace(options:{
  roots:string[]
  action:AgentWorkMutationDto
  executable?:string
}):Promise<{accepted:boolean;message:string}>{
  if(options.roots.length!==1||!isAbsolute(options.roots[0]??''))throw new Error('Verified Hermes installation root is required')
  const root=resolve(options.roots[0]!)
  let args:string[]
  try{args=hermesWorkMutationArgv(options.action)}
  catch(error){return {accepted:false,message:error instanceof Error?error.message:'Invalid Hermes action'}}
  // Hermes itself owns locking, migrations and native persistence.
  // Keep the inherited environment except for HOME routing and nested worker context.
  const env={...process.env,HERMES_HOME:root}
  delete env.HERMES_KANBAN_TASK
  delete env.HERMES_KANBAN_RUN_ID
  delete env.HERMES_KANBAN_BOARD
  delete env.HERMES_SESSION_KEY
  const executable=options.executable??'hermes'
  if(executable.includes('\0'))throw new Error('Invalid Hermes executable')
  try{
    const {stdout,stderr}=await execFileAsync(executable,args,{
      cwd:root,env,encoding:'utf8',timeout:20_000,maxBuffer:MAX_OUTPUT,windowsHide:true,
      shell:false,
    })
    const message=(stdout||stderr||'Hermes accepted the operation').trim().slice(0,2000)
    return {accepted:true,message}
  }catch(e){
    const error=e as Error&{stderr?:string;stdout?:string;code?:string|number}
    // Only CLI exit zero is accepted. Never report a timeout/partial run as success.
    return {accepted:false,message:error.killed
      ? 'Hermes operation timed out; the outcome is unknown. Refresh before retrying.'
      : 'Hermes operation failed: '+(error.stderr||error.message||'unknown error').slice(0,1800)}
  }
}
