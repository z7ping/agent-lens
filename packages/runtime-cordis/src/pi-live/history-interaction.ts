import { open, stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import type { SourceRecord, SourceSession, StorageService } from '@agent-lens/core'
import type { PiLiveHistoryAction, PiLiveStartInput } from './types'

const PI_SESSION_HEADER_BYTES = 64 * 1024
const MAX_RESUME_SOURCE_SESSIONS = 8

function interactionError(message: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.code = 'live_interaction_unavailable'
  return error
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function sourceRecordCwd(value: SourceRecord): string | undefined {
  const cwd = record(record(value.payload).session).cwd
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined
}

async function resumablePiRecord(
  storage: StorageService,
  sourceSessions: readonly SourceSession[],
): Promise<SourceRecord | null> {
  for (const sourceSession of sourceSessions) {
    // Pi's first JSONL "session" row uses the session id as its native event id.
    // idx_source_records_native(source_id, installation_id, native_id) makes this
    // an identity lookup independent of the transcript length.
    const item = await storage.repositories.sourceRecords.findByNativeId(
      'pi',
      sourceSession.installationId,
      sourceSession.nativeSessionId,
    )
    if (
      item
      && item.sourceId === 'pi'
      && item.sourceSessionNativeId === sourceSession.nativeSessionId
      && item.locator.kind === 'file'
      && typeof item.locator.path === 'string'
      && isAbsolute(item.locator.path)
      && extname(item.locator.path).toLowerCase() === '.jsonl'
    ) return item
  }
  return null
}

async function isMatchingPiSessionFile(
  sessionPath: string,
  nativeSessionIds: ReadonlySet<string>,
): Promise<boolean> {
  const file = await open(sessionPath, 'r').catch(() => null)
  if (!file) return false
  try {
    const buffer = Buffer.alloc(PI_SESSION_HEADER_BYTES)
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0]?.trim()
    if (!firstLine) return false
    const header = record(JSON.parse(firstLine))
    return header.type === 'session'
      && typeof header.id === 'string'
      && nativeSessionIds.has(header.id)
  } catch {
    return false
  } finally {
    await file.close().catch(() => undefined)
  }
}

/**
 * Pi owns the translation from an AgentLens logical history session to its
 * native JSONL continuation input. Product surfaces never receive native paths.
 */
export async function resolvePiLiveHistoryInput(
  storage: StorageService,
  logicalSessionId: string,
  historyAction: PiLiveHistoryAction = 'continue',
): Promise<PiLiveStartInput> {
  const listSourceSessions = storage.repositories.sessions.listSourceSessionsByLogicalSession
  if (!listSourceSessions) {
    throw interactionError('当前存储不支持有界历史定位，无法继续会话')
  }

  // 两次索引查询互不依赖。继续会话位于跳转关键路径，不能让繁忙的本地
  // Reader Pool 将它们放大成两段连续等待，阻塞 Live 路由挂载。
  const [logicalSession, sourceSessionsForProduct] = await Promise.all([
    storage.repositories.sessions.getLogicalSession(logicalSessionId),
    listSourceSessions(logicalSessionId, {
      sourceId: 'pi',
      limit: MAX_RESUME_SOURCE_SESSIONS,
    }),
  ])
  if (!logicalSession) throw interactionError('历史会话不存在或已被移除')
  if (!sourceSessionsForProduct.length) throw interactionError('该历史会话不支持继续')

  const nativeSessionIds = new Set(sourceSessionsForProduct.map(item => item.nativeSessionId))
  // SourceRecord 与可选 Workspace 查询也彼此独立；保留 Workspace 的 cwd
  // 优先级，同时将两次数据读取移出串行请求路径。
  const [sourceRecord, workspace] = await Promise.all([
    resumablePiRecord(storage, sourceSessionsForProduct),
    logicalSession.workspaceId
      ? storage.repositories.sessions.getWorkspace(logicalSession.workspaceId)
      : Promise.resolve(null),
  ])
  const sessionPath = sourceRecord?.locator.path
  if (!sessionPath) throw interactionError('找不到该会话的原生历史文件，无法继续会话')

  const file = await stat(sessionPath).catch(() => null)
  if (!file?.isFile()) throw interactionError('该会话的原生历史文件已不存在，无法继续会话')
  if (!await isMatchingPiSessionFile(sessionPath, nativeSessionIds)) {
    throw interactionError('原生历史文件与该历史会话不匹配，已拒绝继续')
  }

  const cwd = workspace?.path?.trim() || sourceRecordCwd(sourceRecord)
  if (!cwd) throw interactionError('该会话缺少原始工作目录，无法安全继续')

  return { cwd, sessionPath, historyAction, logicalSessionId }
}
