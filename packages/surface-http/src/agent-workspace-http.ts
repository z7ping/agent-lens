import type { IncomingMessage, ServerResponse } from 'node:http'
import { AGENT_LENS_PROTOCOL_VERSION, type AgentWorkspaceResponseDto } from '@agent-lens/protocol'
import type { CapturePolicyService, SourceService } from '@agent-lens/core'
import { badRequest, writeJson } from './http-utils'

export type AgentWorkspaceReader = (options?: {
  board?: string
  offset?: number
  limit?: number
  jobId?: string
  profile?: string
  executionOffset?: number
  scheduleOffset?: number
}) => Promise<AgentWorkspaceResponseDto>

const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/

/** Provider-owned read-only workspace query. No hardcoded Agent UI or source data interpretation. */
export async function handleAgentWorkspaceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  providers: Readonly<Record<string, AgentWorkspaceReader>> | undefined,
  sources: SourceService,
  policy: CapturePolicyService,
): Promise<boolean> {
  const match = /^\/api\/v1\/agents\/([^/]+)\/workspace$/.exec(url.pathname)
  if (!match) return false
  if (request.method !== 'GET') {
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
  const provider = providers?.[sourceId]
  if (!provider) {
    // No workspace provider does not mean the Agent's other functionality is broken.
    writeJson(response,200,{sourceId,features:[],projects:[],boards:[],tasks:[],runs:[],
      tasksHasMore:false,schedules:[],schedulesHasMore:false,schedulesTotal:0,executions:[],executionsHasMore:false,meta:{protocolVersion:AGENT_LENS_PROTOCOL_VERSION,generatedAt:new Date().toISOString()}})
    return true
  }
  if ([...url.searchParams.keys()].some(key => !['board','offset','limit','jobId','profile','executionOffset','scheduleOffset'].includes(key))) {
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
  if (offsetText && !/^\d{1,6}$/.test(offsetText)) throw badRequest('Invalid offset')
  if (limitText && !/^\d{1,3}$/.test(limitText)) throw badRequest('Invalid limit')
  if (jobId && (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId) || !profile || !/^[a-zA-Z0-9_-]{1,80}$/.test(profile))) throw badRequest('Invalid job identity')
  if (scheduleOffsetText && !/^\d{1,6}$/.test(scheduleOffsetText)) throw badRequest('Invalid schedule offset')
  if (execOffsetText && !/^\d{1,6}$/.test(execOffsetText)) throw badRequest('Invalid execution offset')
  const offset = offsetText ? Number(offsetText) : 0
  const limit = limitText ? Number(limitText) : 40
  const executionOffset = execOffsetText ? Number(execOffsetText) : 0
  const scheduleOffset = scheduleOffsetText ? Number(scheduleOffsetText) : 0
  if (offset > 100000 || executionOffset > 100000 || scheduleOffset > 100000 || limit < 1 || limit > 100) throw badRequest('Workspace page outside budget')
  const result = await provider({
    ...(board ? {board} : {}),
    offset,
    limit,
    ...(jobId && profile?{jobId,profile,executionOffset}:{}),
    scheduleOffset,
  })
  if (result.sourceId !== sourceId) {
    writeJson(response,502,{error:'Workspace provider source identity mismatch'})
    return true
  }
  writeJson(response,200,result)
  return true
}
