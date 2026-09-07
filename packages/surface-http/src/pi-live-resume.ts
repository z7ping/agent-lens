import { open, stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import type { SourceRecord, StorageService } from '@agent-lens/core'
import type { PiLiveHistoryAction, PiLiveStartInput } from '@agent-lens/runtime-cordis'

const PI_SESSION_HEADER_BYTES = 64 * 1024

function httpError(statusCode: number, message: string): Error {
  const error = new Error(message) as Error & { statusCode?: number }
  error.statusCode = statusCode
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

export async function resolvePiLiveResumeInput(
  storage: StorageService,
  logicalSessionId: string,
  historyAction: PiLiveHistoryAction = 'continue',
): Promise<PiLiveStartInput> {
  const logicalSession = await storage.repositories.sessions.getLogicalSession(logicalSessionId)
  if (!logicalSession) throw httpError(404, '历史会话不存在或已被移除')

  const observations = await storage.repositories.observations.query({ logicalSessionId, limit: 5_000 })
  const sourceSessionIds = [...new Set(observations.map(item => item.sourceSessionId))]
  const sourceSessions = await Promise.all(sourceSessionIds.map(id => storage.repositories.sessions.getSourceSession(id)))
  const piSourceSessions = sourceSessions.filter(item => item?.sourceId === 'pi')
  if (!piSourceSessions.length) throw httpError(409, '只有本机 Pi 历史会话可以继续')

  const piSourceSessionIds = new Set(piSourceSessions.map(item => item!.id))
  const nativeSessionIds = new Set(piSourceSessions.map(item => item!.nativeSessionId))
  const evidenceIds = [...new Set(observations
    .filter(item => piSourceSessionIds.has(item.sourceSessionId))
    .flatMap(item => item.evidenceRefs))]
  const sourceRecord = await resumablePiRecord(storage, evidenceIds, nativeSessionIds)
  const sessionPath = sourceRecord?.locator.path
  if (!sessionPath) throw httpError(409, '找不到该 Pi 会话的原生 JSONL，无法继续会话')

  const file = await stat(sessionPath).catch(() => null)
  if (!file?.isFile()) throw httpError(409, '该 Pi 会话的原生 JSONL 已不存在，无法继续会话')
  if (!await isMatchingPiSessionFile(sessionPath, nativeSessionIds)) {
    throw httpError(409, '原生 JSONL 与该 Pi 历史会话不匹配，已拒绝继续')
  }

  const workspace = logicalSession.workspaceId
    ? await storage.repositories.sessions.getWorkspace(logicalSession.workspaceId)
    : null
  const cwd = workspace?.path?.trim() || sourceRecordCwd(sourceRecord)
  if (!cwd) throw httpError(409, '该 Pi 会话缺少原始工作目录，无法安全继续')

  return { cwd, sessionPath, historyAction }
}
