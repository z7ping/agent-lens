import type { AgentWorkMutationDto } from '@agent-lens/protocol'
import { readHermesWorkspace } from './workspace.js'

export type NativeMutationVerification = {
  verification:'confirmed'|'unconfirmed'|'not-verifiable'
  verificationMessage:string
}
const unknown=(reason:string):NativeMutationVerification=>({
  verification:'unconfirmed',verificationMessage:reason,
})
const unavailable=(reason:string):NativeMutationVerification=>({
  verification:'not-verifiable',verificationMessage:reason,
})
const confirmed:NativeMutationVerification={
  verification:'confirmed',
  verificationMessage:'Requested state was observed in the Hermes native workspace.',
}

/** Verify only states the existing read-only DTO can prove. No parallel native parser or storage. */
export async function verifyHermesWorkMutation(root:string,action:AgentWorkMutationDto):Promise<NativeMutationVerification> {
  if(action.kind==='cron.run'||action.kind==='cron.cancel') {
    return unavailable('Asynchronous execution outcome must be checked in Hermes native execution history.')
  }
  if(action.kind==='cron.create'||action.kind==='task.create') {
    return unavailable('Hermes CLI did not return a structured native identity for exact read-back.')
  }
  const boardId='boardId' in action?action.boardId:
    'slug' in action?action.slug:undefined
  const jobId='jobId' in action?action.jobId:undefined
  const profile='profile' in action?action.profile:undefined
  const taskId='taskId' in action?action.taskId:
    'parentId' in action?action.parentId:undefined
  let page
  try {
    page=await readHermesWorkspace({roots:[root],...(boardId?{board:boardId}:{}),
      ...(taskId?{taskId}:{}),...(jobId&&profile?{jobId,profile}:{}),
      limit:100,boardOffset:0,scheduleOffset:0})
  } catch {
    return unknown('Native workspace could not be read after the CLI operation.')
  }
  const category=action.kind.startsWith('cron.')?'schedules':'boards'
  const feature=page.features.find(f=>f.id===category)
  if(feature?.availability!=='available') {
    return unknown('Native '+category+' data is not fully available for verification.')
  }
  if(action.kind.startsWith('board.')) {
    const board=page.boards.find(item=>item.id===action.slug)
    if(action.kind==='board.create')return board ? confirmed : unknown('Created board is not visible in the bounded native read.')
    if(action.kind==='board.rename')return board?.name===action.name ? confirmed : unknown('Updated board name has not been observed.')
    if(action.kind==='board.archive')return !board&&!page.boardsHasMore ? confirmed : unknown('Board archive has not been confirmed.')
  }
  if(action.kind.startsWith('task.')) {
    const item=('taskId' in action)?page.tasks.find(task=>task.id===action.taskId):undefined
    if(action.kind==='task.link') {
      return page.taskLinks.some(link=>link.parentId===action.parentId&&link.childId===action.childId)
        ? confirmed : unknown('Task dependency has not been observed.')
    }
    if(action.kind==='task.unlink')return unavailable('The bounded dependency list cannot prove absence of a link.')
    if(!item)return unknown('Target task is not visible on the bounded native task page.')
    switch(action.kind) {
      case 'task.edit':
        return action.body===undefined && (action.title===undefined||item.title===action.title)
          && (action.priority===undefined||item.priority===action.priority)
          ? confirmed : unknown('Some edited task fields cannot be confirmed from native read-only data.')
      case 'task.assign':return item.assignee===action.profile ? confirmed : unknown('Task assignee differs from the requested profile.')
      case 'task.archive':return item.status==='archived' ? confirmed : unknown('Task archival state has not been observed.')
      case 'task.block':return item.status==='blocked' ? confirmed : unknown('Task is not blocked in the native board.')
      case 'task.unblock':return !['blocked','scheduled'].includes(item.status) ? confirmed : unknown('Task is still blocked or scheduled.')
      case 'task.complete':return item.status==='done' ? confirmed : unknown('Task is not marked done in the native board.')
      case 'task.promote':return item.status==='ready' ? confirmed : unknown('Task is not yet ready in the native board.')
    }
  }
  if(action.kind.startsWith('cron.')) {
    const job=page.schedules.find(item=>item.profile===action.profile&&'jobId' in action&&item.id===action.jobId)
    if(action.kind==='cron.remove')return !job && !page.schedulesHasMore ? confirmed : unknown('Removed job cannot be conclusively verified.')
    if(!job)return unknown('Target Cron job is outside the bounded native read.')
    if(action.kind==='cron.pause')return !job.enabled ? confirmed : unknown('Cron job is still enabled.')
    if(action.kind==='cron.resume')return job.enabled ? confirmed : unknown('Cron job is not enabled.')
    if(action.kind==='cron.edit') {
      if(action.prompt!==undefined)return unavailable('Cron prompts are intentionally omitted from the read-only overview.')
      return (action.name===undefined||job.name===action.name)
        && (action.schedule===undefined||job.schedule===action.schedule)
        ? confirmed : unknown('Edited Cron state has not been observed.')
    }
  }
  return unavailable('This Hermes mutation has no exact read-back contract.')
}
