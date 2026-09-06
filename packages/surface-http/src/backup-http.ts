import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BackupAssetKind, BackupCreateInput, BackupService } from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type BackupCreateRequestDto,
  type BackupOverviewResponseDto,
  type BackupRestorePreviewResponseDto,
  type BackupSnapshotResponseDto,
  type BackupVerifyResponseDto,
} from '@agent-lens/protocol'
import { badRequest, httpError, readJsonBody, writeJson } from './http-utils'

const MAX_BACKUP_BODY_BYTES = 256 * 1024 * 1024
const BACKUP_KINDS: ReadonlySet<string> = new Set([
  'skill', 'mcp', 'plugin', 'extension', 'hook', 'memory', 'rule', 'session', 'config', 'other',
])

function writeBytes(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  content: Buffer,
  headers: Record<string, string> = {},
): void {
  response.statusCode = statusCode
  response.setHeader('content-type', contentType)
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-length', content.byteLength)
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value)
  response.end(content)
}

function responseMeta() {
  return {
    protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
  }
}

function isBackupKind(value: unknown): value is BackupAssetKind {
  return typeof value === 'string' && BACKUP_KINDS.has(value)
}

function parseKind(value: string | null): BackupAssetKind | undefined {
  if (!value) return undefined
  if (!isBackupKind(value)) throw badRequest(`Unknown backup kind: ${value}`)
  return value
}

function parseKinds(value: unknown): BackupAssetKind[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(isBackupKind)) {
    throw badRequest('kinds must be an array of known backup kinds')
  }
  return [...new Set(value)]
}

function parseSourceIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw badRequest('sourceIds must be an array of strings')
  }
  const normalized = [...new Set(value.map(item => item.trim()).filter(Boolean))]
  if (normalized.length !== value.length) throw badRequest('sourceIds must contain unique non-empty strings')
  return normalized
}

function parseCreateRequest(value: unknown): BackupCreateRequestDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Backup create request must be an object')
  }
  const record = value as Record<string, unknown>
  const sourceIds = parseSourceIds(record.sourceIds)
  const kinds = parseKinds(record.kinds)
  return {
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(kinds === undefined ? {} : { kinds }),
  }
}

function toCreateInput(value: BackupCreateRequestDto): BackupCreateInput {
  return {
    ...(value.sourceIds === undefined ? {} : { sourceIds: value.sourceIds }),
    ...(value.kinds === undefined ? {} : { kinds: value.kinds }),
  }
}

async function readBundle(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > MAX_BACKUP_BODY_BYTES) throw httpError(413, 'Backup file is too large')
    chunks.push(bytes)
  }
  if (!chunks.length) throw badRequest('Backup payload is required')
  return Buffer.concat(chunks)
}

function overviewInput(url: URL): BackupCreateInput {
  const kind = parseKind(url.searchParams.get('kind'))
  const sourceId = url.searchParams.get('sourceId')?.trim()
  return {
    ...(sourceId ? { sourceIds: [sourceId] } : {}),
    ...(kind ? { kinds: [kind] } : {}),
  }
}

export async function handleBackupRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  backup?: BackupService,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/backups' && !url.pathname.startsWith('/api/v1/backups/')) return false
  if (!backup) {
    writeJson(response, 503, { error: 'backup_unavailable' })
    return true
  }

  if (url.pathname === '/api/v1/backups' && request.method === 'GET') {
    const body: BackupOverviewResponseDto = {
      ...await backup.overview(overviewInput(url)),
      meta: responseMeta(),
    }
    writeJson(response, 200, body)
    return true
  }

  if (url.pathname === '/api/v1/backups/refresh' && request.method === 'POST') {
    if (!backup.refreshIndex) {
      writeJson(response, 501, { error: 'backup_refresh_unavailable' })
      return true
    }
    const body: BackupOverviewResponseDto = {
      ...await backup.refreshIndex(),
      meta: responseMeta(),
    }
    writeJson(response, 200, body)
    return true
  }

  if (url.pathname === '/api/v1/backups' && request.method === 'POST') {
    const input = toCreateInput(parseCreateRequest(await readJsonBody(request, { maxBytes: MAX_BACKUP_BODY_BYTES })))
    const snapshot = await backup.createSnapshot(input)
    const body: BackupSnapshotResponseDto = { snapshot, meta: responseMeta() }
    writeJson(response, 201, body)
    return true
  }

  if (url.pathname === '/api/v1/backups/import' && request.method === 'POST') {
    const snapshot = await backup.importSnapshot(await readBundle(request))
    const body: BackupSnapshotResponseDto = { snapshot, meta: responseMeta() }
    writeJson(response, 201, body)
    return true
  }

  const match = url.pathname.match(/^\/api\/v1\/backups\/([^/]+)(?:\/(verify|restore-preview|export))?$/)
  if (!match) {
    writeJson(response, 404, { error: 'not_found' })
    return true
  }
  const id = decodeURIComponent(match[1]!)
  const action = match[2]

  if (!action && request.method === 'GET') {
    const snapshot = await backup.getSnapshot(id)
    if (!snapshot) {
      writeJson(response, 404, { error: 'not_found' })
      return true
    }
    const body: BackupSnapshotResponseDto = { snapshot, meta: responseMeta() }
    writeJson(response, 200, body)
    return true
  }

  if (action === 'verify' && request.method === 'POST') {
    const verified = await backup.verifySnapshot(id)
    const body: BackupVerifyResponseDto = { ...verified, meta: responseMeta() }
    writeJson(response, 200, body)
    return true
  }

  if (action === 'restore-preview' && request.method === 'GET') {
    const preview = await backup.previewRestore(id)
    const body: BackupRestorePreviewResponseDto = {
      ...preview,
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
    }
    writeJson(response, 200, body)
    return true
  }

  if (action === 'export' && request.method === 'GET') {
    const bytes = Buffer.from(await backup.exportSnapshot(id))
    writeBytes(response, 200, 'application/vnd.agentlens.backup', bytes, {
      'content-disposition': `attachment; filename="${id}.agentlens-backup"`,
    })
    return true
  }

  writeJson(response, 405, { error: 'method_not_allowed' })
  return true
}

export const backupHttpInternals = {
  isBackupKind,
  parseKind,
  parseKinds,
  parseSourceIds,
  parseCreateRequest,
  overviewInput,
}
