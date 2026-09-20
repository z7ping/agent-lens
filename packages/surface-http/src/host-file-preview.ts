import { basename, dirname, isAbsolute } from 'node:path'
import type {
  HostFilePreviewResponseDto,
  ManagedAssetPreviewBlockedReason,
} from '@agent-lens/protocol'
import { AGENT_LENS_PROTOCOL_VERSION } from '@agent-lens/protocol'
import {
  ManagedFileError,
  inspectManagedFile,
  previewManagedTextFile,
} from '@agent-lens/source-support'
import { badRequest, httpError } from './http-utils'

function hostFileError(error: ManagedFileError): Error {
  if (error.code === 'not-found') return httpError(404, error.message)
  if (error.code === 'not-file') return httpError(409, error.message)
  if (error.code === 'too-large') return httpError(413, error.message)
  if (error.code === 'binary' || error.code === 'protected-data') return httpError(415, error.message)
  if (
    error.code === 'outside-root'
    || error.code === 'symlink'
    || error.code === 'sensitive'
    || error.code === 'unreadable'
  ) return httpError(403, error.message)
  return badRequest(error.message)
}

function previewBlockedReason(error: ManagedFileError): ManagedAssetPreviewBlockedReason | undefined {
  return error.code === 'sensitive'
    || error.code === 'protected-data'
    || error.code === 'too-large'
    || error.code === 'binary'
    || error.code === 'unreadable'
    ? error.code
    : undefined
}

/**
 * Explicit-user-action preview for an absolute path on the AgentLens host.
 * It intentionally reuses Managed File protections for size, binary/runtime
 * data, credential-like file names and secret redaction.
 */
export async function previewLocalHostTextFile(path: string): Promise<HostFilePreviewResponseDto> {
  const targetPath = path.trim()
  if (!targetPath || !isAbsolute(targetPath)) throw badRequest('host file preview path must be absolute')

  const rootPath = dirname(targetPath)
  const relativePath = basename(targetPath)

  let metadata
  try {
    metadata = await inspectManagedFile(rootPath, relativePath)
  } catch (error) {
    if (error instanceof ManagedFileError) throw hostFileError(error)
    throw error
  }

  try {
    const preview = await previewManagedTextFile(rootPath, relativePath)
    return {
      path: targetPath,
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
    if (error instanceof ManagedFileError) {
      const blockedReason = previewBlockedReason(error)
      if (blockedReason) {
        return {
          path: targetPath,
          name: metadata.name,
          kind: 'file',
          size: metadata.size,
          modifiedAt: metadata.modifiedAt,
          previewStatus: 'metadata-only',
          blockedReason,
          meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
        }
      }
      throw hostFileError(error)
    }
    throw error
  }
}
