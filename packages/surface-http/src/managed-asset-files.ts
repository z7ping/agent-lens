import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AgentIntegrationRuntimeStatus,
  AgentInstallation,
  StorageService,
} from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type ManagedAssetDirectoryResponseDto,
  type ManagedAssetFileEntryDto,
  type ManagedAssetFilePreviewResponseDto,
  type ManagedAssetRoot,
} from '@agent-lens/protocol'
import {
  DEFAULT_MANAGED_FILE_PREVIEW_BYTES,
  ManagedFileError,
  isEnvironmentSecretFileName,
  isProtectedRuntimeDataFile,
  isSensitiveFileName,
  listManagedDirectory,
  previewManagedTextFile,
} from '@agent-lens/source-support'
import { badRequest, httpError, writeJson } from './http-utils'

type IntegrationStatusReader = (
  productId: string,
) => AgentIntegrationRuntimeStatus | null | Promise<AgentIntegrationRuntimeStatus | null>

function rootPathForInstallation(
  installation: AgentInstallation,
  root: ManagedAssetRoot,
): string | undefined {
  return root === 'config' ? installation.configRoot : installation.dataRoot
}

async function assertAssetsCapability(
  productId: string,
  readStatus?: IntegrationStatusReader,
): Promise<void> {
  if (!readStatus) throw httpError(503, 'integration status is unavailable')
  const status = await readStatus(productId)
  if (!status) throw httpError(404, 'integration not found')
  const assets = status.capabilities.find(item => item.capability === 'assets')
  if (!assets || assets.availability !== 'available') {
    throw httpError(503, 'integration assets capability is unavailable')
  }
}

async function managedRoot(
  storage: StorageService,
  input: {
    productId: string
    installationId: string
    root: ManagedAssetRoot
  },
): Promise<string> {
  const installation = await storage.repositories.installations.get(input.installationId)
  if (!installation || installation.productId !== input.productId) {
    throw httpError(404, 'installation not found for integration')
  }
  const rootPath = rootPathForInstallation(installation, input.root)
  if (!rootPath) throw httpError(404, `${input.root} root is unavailable`)
  return rootPath
}

function managedFileHttpError(error: ManagedFileError): Error {
  if (error.code === 'not-found') return httpError(404, error.message)
  if (error.code === 'too-large') return httpError(413, error.message)
  if (error.code === 'binary' || error.code === 'protected-data') return httpError(415, error.message)
  if (
    error.code === 'outside-root'
    || error.code === 'symlink'
    || error.code === 'sensitive'
    || error.code === 'unreadable'
  ) {
    return httpError(403, error.message)
  }
  return badRequest(error.message)
}

function directoryEntry(entry: Awaited<ReturnType<typeof listManagedDirectory>>['entries'][number]): ManagedAssetFileEntryDto {
  const sensitive = entry.kind === 'file'
    && (isSensitiveFileName(entry.relativePath) || isEnvironmentSecretFileName(entry.relativePath))
  const protectedData = entry.kind === 'file' && isProtectedRuntimeDataFile(entry.relativePath)
  const previewable = entry.kind === 'file'
    && !sensitive
    && !protectedData
    && (entry.size ?? Number.POSITIVE_INFINITY) <= DEFAULT_MANAGED_FILE_PREVIEW_BYTES

  return {
    name: entry.name,
    relativePath: entry.relativePath,
    kind: entry.kind,
    accessible: entry.kind !== 'symlink',
    ...(entry.kind === 'symlink' ? { symlink: true } : {}),
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.modifiedAt ? { modifiedAt: entry.modifiedAt } : {}),
    ...(sensitive ? { sensitive: true } : {}),
    ...(entry.kind === 'file' ? { previewable } : {}),
  }
}

export async function readManagedAssetDirectory(
  storage: StorageService,
  input: {
    productId: string
    installationId: string
    root: ManagedAssetRoot
    relativePath?: string
  },
): Promise<ManagedAssetDirectoryResponseDto> {
  const rootPath = await managedRoot(storage, input)
  try {
    const listing = await listManagedDirectory(rootPath, input.relativePath ?? '')
    return {
      productId: input.productId,
      installationId: input.installationId,
      root: input.root,
      rootPath,
      relativePath: listing.relativePath,
      entries: listing.entries.map(directoryEntry),
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
    }
  } catch (error) {
    if (error instanceof ManagedFileError) throw managedFileHttpError(error)
    throw error
  }
}

export async function readManagedAssetFile(
  storage: StorageService,
  input: {
    productId: string
    installationId: string
    root: ManagedAssetRoot
    relativePath: string
  },
): Promise<ManagedAssetFilePreviewResponseDto> {
  const rootPath = await managedRoot(storage, input)
  if (!input.relativePath.trim()) throw badRequest('file path is required')

  try {
    const preview = await previewManagedTextFile(rootPath, input.relativePath)
    return {
      productId: input.productId,
      installationId: input.installationId,
      root: input.root,
      rootPath,
      relativePath: preview.relativePath,
      name: preview.name,
      size: preview.size,
      modifiedAt: preview.modifiedAt,
      content: preview.content,
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
    }
  } catch (error) {
    if (error instanceof ManagedFileError) throw managedFileHttpError(error)
    throw error
  }
}

function routeMatch(pathname: string): { productId: string; kind: 'files' | 'file' } | null {
  const match = pathname.match(/^\/api\/v1\/integrations\/([^/]+)\/assets\/(files|file)$/)
  if (!match) return null
  let productId: string
  try {
    productId = decodeURIComponent(match[1]!)
  } catch {
    throw badRequest('integration id is malformed')
  }
  return {
    productId,
    kind: match[2] as 'files' | 'file',
  }
}

function queryRoot(url: URL): ManagedAssetRoot {
  const root = url.searchParams.get('root')
  if (root !== 'config' && root !== 'data') throw badRequest('root must be config or data')
  return root
}

export async function handleManagedAssetFilesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storage: StorageService,
  readIntegrationStatus?: IntegrationStatusReader,
): Promise<boolean> {
  const route = routeMatch(url.pathname)
  if (!route) return false

  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }

  await assertAssetsCapability(route.productId, readIntegrationStatus)

  const installationId = url.searchParams.get('installationId')?.trim()
  if (!installationId) throw badRequest('installationId is required')
  const root = queryRoot(url)
  const relativePath = url.searchParams.get('path') ?? ''

  const body = route.kind === 'files'
    ? await readManagedAssetDirectory(storage, {
      productId: route.productId,
      installationId,
      root,
      relativePath,
    })
    : await readManagedAssetFile(storage, {
      productId: route.productId,
      installationId,
      root,
      relativePath,
    })

  writeJson(response, 200, body)
  return true
}
