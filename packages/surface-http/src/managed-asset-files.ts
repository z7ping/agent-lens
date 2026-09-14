import { lstat } from 'node:fs/promises'
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
  inspectManagedFile,
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
  if (root === 'config') return installation.configRoot
  if (root === 'data') return installation.dataRoot
  return undefined
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
    bindingId?: string
  },
): Promise<string> {
  const installation = await storage.repositories.installations.get(input.installationId)
  if (!installation || installation.productId !== input.productId) {
    throw httpError(404, 'installation not found for integration')
  }

  if (input.root === 'binding') {
    const bindingId = input.bindingId?.trim()
    if (!bindingId) throw badRequest('bindingId is required for binding root')
    if (!storage.assetInventory) throw httpError(503, 'asset inventory is unavailable')

    const entry = (await storage.assetInventory.listByInstallation(input.installationId))
      .find(item => item.binding.id === bindingId)
    const bindingPath = entry?.binding.path
    if (!entry || !bindingPath) throw httpError(404, 'asset binding path is unavailable')

    try {
      const meta = await lstat(bindingPath)
      if (meta.isSymbolicLink()) throw httpError(403, 'asset binding symbolic links are not previewable')
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error) throw error
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : ''
      if (code === 'ENOENT') throw httpError(404, 'asset binding path does not exist')
      if (code === 'EACCES' || code === 'EPERM') throw httpError(403, 'asset binding path is not readable')
      throw error
    }
    return bindingPath
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
    bindingId?: string
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
    bindingId?: string
  },
): Promise<ManagedAssetFilePreviewResponseDto> {
  const rootPath = await managedRoot(storage, input)
  if (input.root !== 'binding' && !input.relativePath.trim()) throw badRequest('file path is required')

  let metadata
  try {
    metadata = await inspectManagedFile(rootPath, input.relativePath)
  } catch (error) {
    if (error instanceof ManagedFileError) throw managedFileHttpError(error)
    throw error
  }

  try {
    const preview = await previewManagedTextFile(rootPath, input.relativePath)
    return {
      productId: input.productId,
      installationId: input.installationId,
      root: input.root,
      rootPath,
      relativePath: preview.relativePath,
      name: preview.name,
      kind: 'file',
      size: preview.size,
      modifiedAt: preview.modifiedAt,
      previewStatus: preview.redacted ? 'redacted' : 'readable',
      content: preview.content,
      ...(preview.redacted ? { redacted: true } : {}),
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
    }
  } catch (error) {
    if (error instanceof ManagedFileError && (
      error.code === 'sensitive'
      || error.code === 'protected-data'
      || error.code === 'too-large'
      || error.code === 'binary'
      || error.code === 'unreadable'
    )) {
      return {
        productId: input.productId,
        installationId: input.installationId,
        root: input.root,
        rootPath,
        relativePath: metadata.relativePath,
        name: metadata.name,
        kind: 'file',
        size: metadata.size,
        modifiedAt: metadata.modifiedAt,
        previewStatus: 'metadata-only',
        blockedReason: error.code,
        meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
      }
    }
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
  if (root !== 'config' && root !== 'data' && root !== 'binding') {
    throw badRequest('root must be config, data or binding')
  }
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
  const bindingId = url.searchParams.get('bindingId')?.trim() || undefined

  const body = route.kind === 'files'
    ? await readManagedAssetDirectory(storage, {
      productId: route.productId,
      installationId,
      root,
      relativePath,
      ...(bindingId ? { bindingId } : {}),
    })
    : await readManagedAssetFile(storage, {
      productId: route.productId,
      installationId,
      root,
      relativePath,
      ...(bindingId ? { bindingId } : {}),
    })

  writeJson(response, 200, body)
  return true
}