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
const VALIDATION_CONCURRENCY = 4
const VALIDATION_CACHE_TTL_MS = 30_000
const MAX_SEARCH_LENGTH = 200
const validationRefreshes = new Map<string, Promise<void>>()

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

type WorkspaceValidator = (workspacePath: string) => Promise<string>
type WorkspaceValidationRecorder = (input: {
  workspaceId: string
  workspacePath: string
  status: 'valid' | 'invalid'
  validatedAt: string
}) => Promise<void>

export interface LaunchableProjectTimings {
  dbMs: number
  fsMs: number
  totalMs: number
}

type TimingObserver = (timings: LaunchableProjectTimings) => void

function launchableProjectDto(
  candidate: LaunchableProjectCandidate,
  workspaceId: string,
  workspacePath: string,
): LaunchableProjectDto {
  return {
    key: candidate.key,
    ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
    ...(candidate.projectName ? { projectName: candidate.projectName } : {}),
    ...(candidate.repositoryIdentity ? { repositoryIdentity: candidate.repositoryIdentity } : {}),
    workspaceId,
    workspacePath,
    // Keep the project-level activity key used by server ordering/cursors. The chosen
    // workspace may be older only because a newer historical worktree no longer exists.
    lastSeenAt: candidate.lastSeenAt,
  }
}

function validationFresh(validatedAt: string | undefined, nowMs: number): boolean {
  if (!validatedAt) return false
  const timestamp = Date.parse(validatedAt)
  return Number.isFinite(timestamp)
    && timestamp <= nowMs
    && nowMs - timestamp <= VALIDATION_CACHE_TTL_MS
}

function recordValidation(
  recorder: WorkspaceValidationRecorder | undefined,
  input: Parameters<WorkspaceValidationRecorder>[0],
): void {
  if (!recorder) return
  void recorder(input).catch(() => undefined)
}

function refreshValidationInBackground(
  workspace: LaunchableProjectCandidate['workspaces'][number],
  validateWorkspace: WorkspaceValidator,
  recorder: WorkspaceValidationRecorder | undefined,
): void {
  const key = `${workspace.workspaceId}\u0000${workspace.workspacePath}`
  if (validationRefreshes.has(key)) return
  const task = (async () => {
    try {
      await validateWorkspace(workspace.workspacePath)
      recordValidation(recorder, {
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.workspacePath,
        status: 'valid',
        validatedAt: new Date().toISOString(),
      })
    } catch {
      recordValidation(recorder, {
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.workspacePath,
        status: 'invalid',
        validatedAt: new Date().toISOString(),
      })
    }
  })().finally(() => {
    validationRefreshes.delete(key)
  })
  validationRefreshes.set(key, task)
}

async function launchableWorkspace(
  candidate: LaunchableProjectCandidate,
  validateWorkspace: WorkspaceValidator = validatePiWorkingDirectory,
  recorder?: WorkspaceValidationRecorder,
  nowMs = Date.now(),
): Promise<LaunchableProjectDto | undefined> {
  // Fresh cache hits never touch the filesystem. Expired successful paths are shown immediately
  // and revalidated in the background; Pi start still performs its own authoritative cwd check.
  for (const workspace of candidate.workspaces) {
    const fresh = validationFresh(workspace.validatedAt, nowMs)
    if (workspace.validationStatus === 'valid') {
      if (!fresh) refreshValidationInBackground(workspace, validateWorkspace, recorder)
      return launchableProjectDto(candidate, workspace.workspaceId, workspace.workspacePath)
    }
    if (workspace.validationStatus === 'invalid') {
      if (!fresh) refreshValidationInBackground(workspace, validateWorkspace, recorder)
      continue
    }

    try {
      const workspacePath = await validateWorkspace(workspace.workspacePath)
      recordValidation(recorder, {
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.workspacePath,
        status: 'valid',
        validatedAt: new Date(nowMs).toISOString(),
      })
      return launchableProjectDto(candidate, workspace.workspaceId, workspacePath)
    } catch {
      recordValidation(recorder, {
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.workspacePath,
        status: 'invalid',
        validatedAt: new Date(nowMs).toISOString(),
      })
      // Unknown/stale path failed: try the next observed workspace for this project.
    }
  }
  return undefined
}

export async function readLaunchableProjects(
  storage: StorageService,
  params: URLSearchParams,
  validateWorkspace: WorkspaceValidator = validatePiWorkingDirectory,
  observeTiming?: TimingObserver,
): Promise<LaunchableProjectsResponseDto> {
  const reader = storage.launchableProjects
  if (!reader) throw httpError(503, '本机项目发现暂不可用')

  const totalStartedAt = performance.now()
  const limit = parseLimit(params, MAX_LIMIT) ?? DEFAULT_LIMIT
  const search = searchValue(params)
  const after = decodeCursor(params.get('cursor'))
  const batchLimit = Math.max(limit, Math.min(QUERY_BATCH_SIZE, limit * 2))
  const dbStartedAt = performance.now()
  const page = await reader.query({
    limit: batchLimit,
    ...(search ? { search } : {}),
    ...(after ? { after } : {}),
  })
  const dbMs = performance.now() - dbStartedAt

  const items: LaunchableProjectDto[] = []
  const fsStartedAt = performance.now()
  const validationRecorder = reader.recordWorkspaceValidation
    ? input => reader.recordWorkspaceValidation!(input)
    : undefined
  let processed = 0

  // One request reads one bounded candidate page only. Filesystem checks are
  // parallelized in small waves; slow/stale paths no longer serialize the whole
  // dropdown and the endpoint never scans 200 candidates just to fill 20 rows.
  for (let offset = 0; offset < page.items.length && items.length < limit; offset += VALIDATION_CONCURRENCY) {
    const chunk = page.items.slice(offset, offset + VALIDATION_CONCURRENCY)
    const resolved = await Promise.all(
      chunk.map(candidate => launchableWorkspace(candidate, validateWorkspace, validationRecorder)),
    )

    for (let index = 0; index < chunk.length; index += 1) {
      processed += 1
      const project = resolved[index]
      if (project) items.push(project)
      if (items.length >= limit) break
    }
  }

  const fsMs = performance.now() - fsStartedAt
  const lastProcessed = processed > 0 ? page.items[processed - 1] : undefined
  const hasMore = page.hasMore || processed < page.items.length
  observeTiming?.({
    dbMs,
    fsMs,
    totalMs: performance.now() - totalStartedAt,
  })

  return {
    items,
    meta: {
      protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
      count: items.length,
      hasMore,
      ...(hasMore && lastProcessed ? {
        nextCursor: encodeCursor({
          lastSeenAt: lastProcessed.lastSeenAt,
          key: lastProcessed.key,
        }),
      } : {}),
      generatedAt: new Date().toISOString(),
    },
  }
}

export const launchableProjectHttpInternals = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  QUERY_BATCH_SIZE,
  VALIDATION_CONCURRENCY,
  VALIDATION_CACHE_TTL_MS,
  validationFresh,
  encodeCursor,
  decodeCursor,
  searchValue,
  launchableWorkspace,
}
