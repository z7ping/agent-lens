import { realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, isAbsolute as isAbsolutePath } from 'node:path'
import { readVerifiedNativeJsonlObject, type NativeJsonlReadResult } from './native-jsonl-read'

export interface NativeReference {
  sourceId: string
  installationId: string
  parserVersion: string
  locator: { kind: string; path?: string; offset?: number }
  fingerprint?: string
}

export type AuthorizedNativeJsonlResult = Exclude<NativeJsonlReadResult, { state: 'available' }>
  | (Extract<NativeJsonlReadResult, { state: 'available' }> & { canonicalPath: string })
  | { state: 'incompatible'; reason: 'source-parser-version-changed' }
  | { state: 'unsupported'; reason: 'source-installation-mismatch' | 'stable-jsonl-reference-required' | 'source-path-outside-authorized-roots' }

/**
 * A Source adapter supplies only roots of the detected installation. This
 * helper is intentionally unaware of Core/Normalizer and never stores data.
 */
export async function readAuthorizedNativeJsonlEntry(input: {
  reference: NativeReference
  installationId: string
  sourceId: string
  parserVersion: string
  allowedRoots: readonly string[]
  abortSignal: AbortSignal
}): Promise<AuthorizedNativeJsonlResult> {
  const { reference, installationId, sourceId, parserVersion, allowedRoots, abortSignal } = input
  if (reference.sourceId !== sourceId || reference.installationId !== installationId) {
    return { state: 'unsupported', reason: 'source-installation-mismatch' }
  }
  if (reference.parserVersion !== parserVersion) {
    return { state: 'incompatible', reason: 'source-parser-version-changed' }
  }
  const filePath = reference.locator.kind === 'file' ? reference.locator.path : undefined
  if (!filePath || !isAbsolute(filePath) || extname(filePath).toLowerCase() !== '.jsonl'
    || reference.locator.offset === undefined || !reference.fingerprint) {
    return { state: 'unsupported', reason: 'stable-jsonl-reference-required' }
  }
  abortSignal.throwIfAborted()
  let canonicalPath: string
  try {
    canonicalPath = await realpath(filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'unavailable', reason: 'source-file-missing' }
    if (code === 'EACCES' || code === 'EPERM') {
      return { state: 'unavailable', reason: 'source-file-not-readable' }
    }
    throw error
  }
  let authorized = false
  for (const root of allowedRoots) {
    if (!root || !isAbsolute(root)) continue
    try {
      const canonicalRoot = await realpath(root)
      const within = relative(canonicalRoot, canonicalPath)
      if (within && within !== '..' && !within.startsWith('..\\') && !within.startsWith('../')
        && !isAbsolutePath(within)) {
        authorized = true
        break
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!authorized) return { state: 'unsupported', reason: 'source-path-outside-authorized-roots' }

  // Hash and parse the same bytes from a single handle, not two opens.
  const result = await readVerifiedNativeJsonlObject({
    path: canonicalPath,
    offset: reference.locator.offset,
    expectedFingerprint: reference.fingerprint,
    abortSignal,
  })
  return result.state === 'available' ? { ...result, canonicalPath } : result
}
