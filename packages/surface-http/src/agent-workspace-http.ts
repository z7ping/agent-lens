import type { IncomingMessage, ServerResponse } from 'node:http'
import { AGENT_LENS_PROTOCOL_VERSION, AGENT_WORK_MUTATION_KINDS, type AgentWorkspaceResponseDto, type AgentWorkOutputResponseDto, type AgentWorkMutationDto, type AgentWorkMutationResultDto } from '@agent-lens/protocol'
import type { CapturePolicyService, SourceService } from '@agent-lens/core'
import { badRequest, httpError, readJsonBody, writeJson } from './http-utils'
import type { WorkspaceWriteAccess } from './agent-workspace-write-access'

export type AgentWorkspaceReader = (options?: {
  board?: string
  offset?: number
  limit?: number
  jobId?: string
  profile?: string
  executionOffset?: number
  scheduleOffset?: number
  roots?: string[]
  taskId?: string
  taskEventOffset?: number
  runOffset?: number
  commentOffset?: number
  projectOffset?: number
  boardOffset?: number
}) => Promise<AgentWorkspaceResponseDto>

export type AgentWorkspaceMutationRunner = (options:{
  roots:string[]
  action:AgentWorkMutationDto
  executable?:string
}) => Promise<{accepted:boolean;message:string}>

export type AgentWorkspaceOutputReader = (options: {
  roots?: string[]
  jobId: string
  profile: string
  file?: string
  offset?: number
}) => Promise<AgentWorkOutputResponseDto>

const FILE_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.md$/
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/

/** Provider-owned read-only workspace query. No hardcoded Agent UI or source data interpretation. */
export async function handleAgentWorkspaceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  providers: Readonly<Record<string, AgentWorkspaceReader>> | undefined,
  sources: SourceService,
  policy: CapturePolicyService,
  resolveInstallationRoot: (sourceId:string,installationId:string)=>Promise<{root:string;executable?:string}|null>,
  outputReaders?: Readonly<Record<string, AgentWorkspaceOutputReader>>,
  mutationRunners?: Readonly<Record<string, AgentWorkspaceMutationRunner>>,
  writeAccess?: WorkspaceWriteAccess,
): Promise<boolean> {
  const match = /^\/api\/v1\/agents\/([^/]+)\/workspace(\/output|\/action|\/write-access)?$/.exec(url.pathname)
  if (!match) return false
  const expectedMethod = match[2] === '/action' ? 'POST'
    : match[2] === '/write-access' ? ['GET', 'PUT'] : ['GET']
  if (!(Array.isArray(expectedMethod) ? expectedMethod : [expectedMethod]).includes(request.method ?? '')) {
    writeJson(response,405,{error:'Method not allowed'})
    return true
  }
  const sourceId = decodeURIComponent(match[1]!)
  const source = sources.list().find(item => item.manifest.sourceId === sourceId)
  if (!source) {
    writeJson(response,404,{error:'Unknown Agent'})
    return true
  }
  if (!policy.isSourceEnabled(sourceId)) {
    writeJson(response,403,{error:'Source disabled'})
    return true
  }
  const installationId = url.searchParams.get('installationId')
  if (installationId && (installationId.length > 256 || /[\\x00-\\x1f]/.test(installationId))) {
    throw badRequest('Invalid installation identity')
  }
  if (match[2] === '/action' || (match[2] === '/write-access' && request.method === 'PUT')) {
    const origin = request.headers.origin
    if ((origin && (!request.headers.host || origin !== 'http://' + request.headers.host))
      || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))) {
      throw httpError(403, 'Cross-origin workspace writes are forbidden')
    }
  }
  if (match[2] === '/write-access') {
    if (!installationId) throw badRequest('Installation is required')
    if ([...url.searchParams.keys()].some(key => key !== 'installationId')) throw badRequest('Unexpected permission parameters')
    const installation = await resolveInstallationRoot(sourceId, installationId)
    if (!installation) { writeJson(response, 404, {error:'Unknown Agent installation'}); return true }
    const scope = {sourceId, installationId, root: installation.root}
    if (request.method === 'GET') {
      writeJson(response, 200, {sourceId, installationId, enabled: writeAccess?.allowed(scope) ?? false})
      return true
    }
    if (!writeAccess) throw httpError(403, 'Workspace writes are not configured')
    if (request.headers['x-agent-lens-workspace-action'] !== 'confirmed') throw httpError(403, 'Explicit permission confirmation is required')
    const body = await readJsonBody(request, {maxBytes: 1024})
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || (body as Record<string,unknown>).confirmed !== true
      || typeof (body as Record<string,unknown>).enabled !== 'boolean'
      || Object.keys(body).some(key => !['confirmed','enabled'].includes(key))) throw badRequest('Invalid workspace permission request')
    const enabled = await writeAccess.set(scope, (body as {enabled:boolean}).enabled)
    writeJson(response, 200, {sourceId, installationId, enabled})
    return true
  }
  if (match[2] === '/action') {
    // Deliberate user confirmation + non-simple request header: local websites
    // cannot silently trigger native filesystem mutations via CSRF.
    if (request.headers['x-agent-lens-workspace-action'] !== 'confirmed') {
      throw httpError(403,'Explicit workspace action confirmation is required')
    }
    if (!installationId) throw badRequest('Installation is required')
    if ([...url.searchParams.keys()].some(key=>key!=='installationId')) {
      throw badRequest('Unexpected workspace action parameters')
    }
    const runner=mutationRunners?.[sourceId]
    if (!runner) {writeJson(response,404,{error:'Workspace writes not supported'});return true}
    const body=await readJsonBody(request,{maxBytes:8192})
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Invalid workspace mutation body')
    const payload=body as Record<string,unknown>
    if (payload.confirmed !== true || !payload.action || typeof payload.action !== 'object' ||
      Array.isArray(payload.action)) throw badRequest('Explicit confirmation and action are required')
    const installation=await resolveInstallationRoot(sourceId,installationId)
    if (!installation) {writeJson(response,404,{error:'Unknown Agent installation'});return true}
    if (!writeAccess?.allowed({sourceId,installationId,root:installation.root})) {
      throw httpError(403, 'Workspace write permission is disabled for this installation')
    }
    // CLI executable comes from the same registered installation when known.
    const result=await runner({roots:[installation.root],action:payload.action as AgentWorkMutationDto,
      ...(installation.executable ? {executable:installation.executable} : {})})
    const answer:AgentWorkMutationResultDto={
      sourceId,installationId,kind:(payload.action as AgentWorkMutationDto).kind,
      accepted:result.accepted,message:result.message,
    }
    writeJson(response,200,answer)
    return true
  }
  if (match[2] === '/output') {
    const outputReader=outputReaders?.[sourceId]
    if (!outputReader) {writeJson(response,404,{error:'Output not supported'});return true}
    if (!installationId) throw badRequest('Installation is required')
    const jobId=url.searchParams.get('jobId')
    const profile=url.searchParams.get('profile')
    const file=url.searchParams.get('file')??undefined
    const offsetText=url.searchParams.get('offset')
    if (!jobId || !/^[a-zA-Z0-9_-]{1,128}$/.test(jobId) || !profile || !/^[a-zA-Z0-9_-]{1,80}$/.test(profile)
      || (file && !FILE_NAME.test(file)) || (offsetText && !/^\d{1,6}$/.test(offsetText))
      || [...url.searchParams.keys()].some(k=>!['jobId','profile','file','offset','installationId'].includes(k))) throw badRequest('Invalid Cron output identity')
    const offset=offsetText?Number(offsetText):0
    if (offset>100000) throw badRequest('Invalid Cron output offset')
    const root=await resolveInstallationRoot(sourceId,installationId)
    if (!root) {writeJson(response,404,{error:'Unknown Agent installation'});return true}
    writeJson(response,200,{...await outputReader({jobId,profile,...(file?{file}:{}),offset,roots:[root.root]}),installationId})
    return true
  }
  const provider = providers?.[sourceId]
  if (!provider) {
    // No workspace provider does not mean the Agent's other functionality is broken.
    writeJson(response,200,{sourceId,features:[],projects:[],projectsTotal:0,projectsHasMore:false,boards:[],boardsTotal:0,boardsHasMore:false,tasks:[],runs:[],runsHasMore:false,taskCommentsHasMore:false,taskLinks:[],taskComments:[],taskEvents:[],taskEventsHasMore:false,
      tasksHasMore:false,schedules:[],schedulesHasMore:false,schedulesTotal:0,executions:[],executionsHasMore:false,meta:{protocolVersion:AGENT_LENS_PROTOCOL_VERSION,generatedAt:new Date().toISOString()}})
    return true
  }
  if (!installationId) throw badRequest('Installation is required')
  if ([...url.searchParams.keys()].some(key => !['installationId','board','offset','limit','jobId','profile','executionOffset','scheduleOffset','taskId','taskEventOffset','runOffset','commentOffset','projectOffset','boardOffset'].includes(key))) {
    throw badRequest('Invalid workspace parameters')
  }
  const board = url.searchParams.get('board') ?? undefined
  if (board && !SLUG.test(board)) throw badRequest('Invalid board')
  const offsetText = url.searchParams.get('offset')
  const limitText = url.searchParams.get('limit')
  const jobId = url.searchParams.get('jobId') ?? undefined
  const profile = url.searchParams.get('profile') ?? undefined
  const execOffsetText = url.searchParams.get('executionOffset')
  const scheduleOffsetText = url.searchParams.get('scheduleOffset')
  const taskId = url.searchParams.get('taskId') ?? undefined
  const taskEventOffsetText = url.searchParams.get('taskEventOffset')
  const runOffsetText = url.searchParams.get('runOffset')
  const commentOffsetText = url.searchParams.get('commentOffset')
  const projectOffsetText = url.searchParams.get('projectOffset')
  const boardOffsetText = url.searchParams.get('boardOffset')
  if (offsetText && !/^\d{1,6}$/.test(offsetText)) throw badRequest('Invalid offset')
  if (limitText && !/^\d{1,3}$/.test(limitText)) throw badRequest('Invalid limit')
  if (taskId && (!board || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId))) throw badRequest('Invalid task identity')
  if (runOffsetText && !/^\d{1,6}$/.test(runOffsetText)) throw badRequest('Invalid run offset')
  if (boardOffsetText && !/^\d{1,6}$/.test(boardOffsetText)) throw badRequest('Invalid board offset')
  if (projectOffsetText && !/^\d{1,6}$/.test(projectOffsetText)) throw badRequest('Invalid project offset')
  if (commentOffsetText && !/^\d{1,6}$/.test(commentOffsetText)) throw badRequest('Invalid comment offset')
  if (taskEventOffsetText && !/^\d{1,6}$/.test(taskEventOffsetText)) throw badRequest('Invalid task event offset')
  if (jobId && (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId) || !profile || !/^[a-zA-Z0-9_-]{1,80}$/.test(profile))) throw badRequest('Invalid job identity')
  if (scheduleOffsetText && !/^\d{1,6}$/.test(scheduleOffsetText)) throw badRequest('Invalid schedule offset')
  if (execOffsetText && !/^\d{1,6}$/.test(execOffsetText)) throw badRequest('Invalid execution offset')
  const offset = offsetText ? Number(offsetText) : 0
  const limit = limitText ? Number(limitText) : 40
  const executionOffset = execOffsetText ? Number(execOffsetText) : 0
  const scheduleOffset = scheduleOffsetText ? Number(scheduleOffsetText) : 0
  const taskEventOffset = taskEventOffsetText ? Number(taskEventOffsetText) : 0
  const runOffset = runOffsetText ? Number(runOffsetText) : 0
  const commentOffset = commentOffsetText ? Number(commentOffsetText) : 0
  const projectOffset = projectOffsetText ? Number(projectOffsetText) : 0
  const boardOffset = boardOffsetText ? Number(boardOffsetText) : 0
  if (offset > 100000 || executionOffset > 100000 || scheduleOffset > 100000 || taskEventOffset > 100000 || runOffset > 100000 || commentOffset > 100000 || projectOffset > 100000 || boardOffset > 100000 || limit < 1 || limit > 100) throw badRequest('Workspace page outside budget')
  const root = await resolveInstallationRoot(sourceId,installationId)
  if (!root) {writeJson(response,404,{error:'Unknown Agent installation'});return true}
  const result = await provider({
    roots: [root.root],
    ...(board ? {board} : {}),
    offset,
    limit,
    ...(jobId && profile?{jobId,profile,executionOffset}:{}),
    scheduleOffset,
    ...(taskId?{taskId,taskEventOffset,runOffset,commentOffset}:{}),
    projectOffset,
    boardOffset,
  })
  if (result.sourceId !== sourceId) {
    writeJson(response,502,{error:'Workspace provider source identity mismatch'})
    return true
  }
  writeJson(response,200,{...result,installationId,
    availableActions:mutationRunners?.[sourceId] && writeAccess?.allowed({sourceId,installationId,root:root.root})
      ? AGENT_WORK_MUTATION_KINDS : []})
  return true
}
