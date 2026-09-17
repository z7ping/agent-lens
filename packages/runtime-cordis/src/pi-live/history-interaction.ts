import { open, stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import type { SourceRecord, StorageService } from '@agent-lens/core'
import type { PiLiveHistoryAction, PiLiveStartInput } from './types'

const PI_SESSION_HEADER_BYTES = 64 * 1024

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
  evidenceIds: readonly string[],
  nativeSessionIds: ReadonlySet<string>,
): Promise<SourceRecord | null> {
  const evidence = storage.repositories.evidence.getMany
    ? await storage.repositories.evidence.getMany([...evidenceIds])
    : await Promise.all(evidenceIds.map(id => storage.repositories.evidence.get(id)))
  const sourceRecordIds = [...new Set(evidence.flatMap(item => item?.sourceRecordId ? [item.sourceRecordId] : []))]
  const sourceRecords = storage.repositories.sourceRecords.getMany
    ? await storage.repositories.sourceRecords.getMany(sourceRecordIds)
    : await Promise.all(sourceRecordIds.map(id => storage.repositories.sourceRecords.get(id)))

  return sourceRecords.find((item): item is SourceRecord => Boolean(
    item
    && item.sourceId === 'pi'
    && item.sourceSessionNativeId
    && nativeSessionIds.has(item.sourceSessionNativeId)
    && item.locator.kind === 'file'
    && typeof item.locator.path === 'string'
    && isAbsolute(item.locator.path)
    && extname(item.locator.path).toLowerCase() === '.jsonl',
  )) ?? null
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
  const logicalSession = await storage.repositories.sessions.getLogicalSession(logicalSessionId)
  if (!logicalSession) throw interactionError('历史会话不存在或已被移除')

  const observations = await storage.repositories.observations.query({ logicalSessionId, limit: 5_000 })
  const sourceSessionIds = [...new Set(observations.map(item => item.sourceSessionId))]
  const sourceSessions = await Promise.all(sourceSessionIds.map(id => storage.repositories.sessions.getSourceSession(id)))
  const sourceSessionsForProduct = sourceSessions.filter(item => item?.sourceId === 'pi')
  if (!sourceSessionsForProduct.length) throw interactionError('该历史会话不支持继续')

  const sourceSessionIdSet = new Set(sourceSessionsForProduct.map(item => item!.id))
  const nativeSessionIds = new Set(sourceSessionsForProduct.map(item => item!.nativeSessionId))
  const evidenceIds = [...new Set(observations
    .filter(item => sourceSessionIdSet.has(item.sourceSessionId))
    .flatMap(item => item.evidenceRefs))]
  const sourceRecord = await resumablePiRecord(storage, evidenceIds, nativeSessionIds)
  const sessionPath = sourceRecord?.locator.path
  if (!sessionPath) throw interactionError('找不到该会话的原生历史文件，无法继续会话')

  const file = await stat(sessionPath).catch(() => null)
  if (!file?.isFile()) throw interactionError('该会话的原生历史文件已不存在，无法继续会话')
  if (!await isMatchingPiSessionFile(sessionPath, nativeSessionIds)) {
    throw interactionError('原生历史文件与该历史会话不匹配，已拒绝继续')
  }

  const workspace = logicalSession.workspaceId
    ? await storage.repositories.sessions.getWorkspace(logicalSession.workspaceId)
    : null
  const cwd = workspace?.path?.trim() || sourceRecordCwd(sourceRecord)
  if (!cwd) throw interactionError('该会话缺少原始工作目录，无法安全继续')

  return { cwd, sessionPath, historyAction }
}
