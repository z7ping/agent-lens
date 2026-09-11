import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SourceService, StorageService } from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type AgentManagedDirectoryResponseDto,
  type AgentManagedRootDto,
  type AgentManagedTextPreviewResponseDto,
} from '@agent-lens/protocol'
import {
  ManagedFileError,
  listManagedDirectory,
  previewManagedTextFile,
} from '@agent-lens/source-support'
import { badRequest, httpError, writeJson } from './http-utils'

function responseMeta() {
  return {
    protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
  }
}

function managedFileHttpError(error: ManagedFileError): Error {
  if (error.code === 'not-found') return httpError(404, error.message)
  if (error.code === 'too-large') return httpError(413, error.message)
  if (error.code === 'binary' || error.code === 'protected-data') return httpError(415, error.message)
  if (error.code === 'outside-root'
    || error.code === 'symlink'
    || error.code === 'sensitive'
    || error.code === 'unreadable') {
    return httpError(403, error.message)
  }
  return badRequest(error.message)
}

function parseRoot(value: string | null): AgentManagedRootDto {
  if (value === 'config' || value === 'data') return value
  throw badRequest('root must be config or data')
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim()
  if (!value) throw badRequest(`${name} is required`)
  return value
}

async function managedRoot(input: {
  sourceId: string
  installationId: string
  root: AgentManagedRootDto
  storage: StorageService
  sources?: SourceService
}): Promise<string> {
  const source = input.sources?.list().find(item => item.manifest.sourceId === input.sourceId)
  if (!source) throw httpError(404, 'Agent source is not registered')

  const installation = await input.storage.repositories.installations.get(input.installationId)
  if (!installation || installation.productId !== source.manifest.productId) {
    throw httpError(404, 'Agent installation was not found for this source')
  }

  const path = input.root === 'config' ? installation.configRoot : installation.dataRoot
  if (!path) throw httpError(404, `Agent installation has no ${input.root} root`)
  return path
}

export async function handleAgentFilesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storage: StorageService,
  sources?: SourceService,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)\/(files|file)$/)
  if (!match) return false

  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const sourceId = decodeURIComponent(match[1]!)
  const action = match[2]!
  const installationId = requiredQuery(url, 'installationId')
  const root = parseRoot(url.searchParams.get('root'))
  const rootPath = await managedRoot({ sourceId, installationId, root, storage, sources })
  const relativePath = url.searchParams.get('path') ?? ''

  try {
    if (action === 'files') {
      const listing = await listManagedDirectory(rootPath, relativePath)
      const body: AgentManagedDirectoryResponseDto = {
        sourceId,
        installationId,
        root,
        rootPath,
        relativePath: listing.relativePath,
        entries: listing.entries,
        meta: responseMeta(),
      }
      writeJson(response, 200, body)
      return true
    }

    if (!relativePath.trim()) throw badRequest('path is required for file preview')
    const preview = await previewManagedTextFile(rootPath, relativePath)
    const body: AgentManagedTextPreviewResponseDto = {
      sourceId,
      installationId,
      root,
      rootPath,
      ...preview,
      meta: responseMeta(),
    }
    writeJson(response, 200, body)
    return true
  } catch (error) {
    if (error instanceof ManagedFileError) throw managedFileHttpError(error)
    throw error
  }
}
