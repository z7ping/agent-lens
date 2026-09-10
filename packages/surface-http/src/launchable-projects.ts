import type { LaunchableProjectCursor, LaunchableProjectCandidate, StorageService } from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type LaunchableProjectDto,
  type LaunchableProjectsResponseDto,
} from '@agent-lens/protocol'
import { badRequest, httpError } from './http-utils'
import { validatePiWorkingDirectory } from './pi-live'
import { parseLimit } from './query-params'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const QUERY_BATCH_SIZE = 40
const MAX_SCAN_PER_REQUEST = 200
const MAX_SEARCH_LENGTH = 200

function encodeCursor(cursor: LaunchableProjectCursor): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    lastSeenAt: cursor.lastSeenAt,
    key: cursor.key,
  }), 'utf8').toString('base64url')
}

function decodeCursor(value: string | null): LaunchableProjectCursor | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid cursor')
    const record = parsed as Record<string, unknown>
    if (record.v !== 1 || typeof record.lastSeenAt !== 'string' || !record.lastSeenAt
      || typeof record.key !== 'string' || !record.key) {
      throw new Error('invalid cursor')
    }
    return { lastSeenAt: record.lastSeenAt, key: record.key }
  } catch {
    throw badRequest('cursor is invalid')
  }
}

function searchValue(params: URLSearchParams): string | undefined {
  const value = params.get('search')?.trim()
  if (!value) return undefined
  if (value.length > MAX_SEARCH_LENGTH) throw badRequest(`search must be at most ${MAX_SEARCH_LENGTH} characters`)
  return value
}

async function launchableWorkspace(candidate: LaunchableProjectCandidate): Promise<LaunchableProjectDto | undefined> {
  const checks = await Promise.all(candidate.workspaces.map(async workspace => {
    try {
      const workspacePath = await validatePiWorkingDirectory(workspace.workspacePath)
      return { ...workspace, workspacePath }
    } catch {
      return undefined
    }
  }))
  const workspace = checks.find(Boolean)
  if (!workspace) return undefined

  return {
    key: candidate.key,
    ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
    ...(candidate.projectName ? { projectName: candidate.projectName } : {}),
    ...(candidate.repositoryIdentity ? { repositoryIdentity: candidate.repositoryIdentity } : {}),
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.workspacePath,
    lastSeenAt: workspace.lastSeenAt,
  }
}

export async function readLaunchableProjects(
  storage: StorageService,
  params: URLSearchParams,
): Promise<LaunchableProjectsResponseDto> {
  const reader = storage.launchableProjects
  if (!reader) throw httpError(503, '本机项目发现暂不可用')

  const limit = parseLimit(params, MAX_LIMIT) ?? DEFAULT_LIMIT
  const search = searchValue(params)
  let after = decodeCursor(params.get('cursor'))
  let hasMore = true
  let scanned = 0
  const items: LaunchableProjectDto[] = []

  while (items.length < limit && hasMore && scanned < MAX_SCAN_PER_REQUEST) {
    const batchLimit = Math.min(QUERY_BATCH_SIZE, MAX_SCAN_PER_REQUEST - scanned)
    const page = await reader.query({
      limit: batchLimit,
      ...(search ? { search } : {}),
      ...(after ? { after } : {}),
    })
    if (!page.items.length) {
      hasMore = false
      break
    }

    let processed = 0
    for (const candidate of page.items) {
      processed += 1
      scanned += 1
      after = { lastSeenAt: candidate.lastSeenAt, key: candidate.key }
      const project = await launchableWorkspace(candidate)
      if (project) items.push(project)

      if (items.length >= limit || scanned >= MAX_SCAN_PER_REQUEST) {
        hasMore = page.hasMore || processed < page.items.length
        break
      }
    }

    if (items.length >= limit || scanned >= MAX_SCAN_PER_REQUEST) break
    hasMore = page.hasMore
  }

  return {
    items,
    meta: {
      protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
      count: items.length,
      hasMore,
      ...(hasMore && after ? { nextCursor: encodeCursor(after) } : {}),
      generatedAt: new Date().toISOString(),
    },
  }
}

export const launchableProjectHttpInternals = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  QUERY_BATCH_SIZE,
  MAX_SCAN_PER_REQUEST,
  encodeCursor,
  decodeCursor,
  searchValue,
  launchableWorkspace,
}
