import { realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, isAbsolute as isAbsolutePath } from 'node:path'
import type { SourceRawHydrationResult, SourceRecord, SourceRawRecoveryContext } from '@agent-lens/core'
import { readVerifiedNativeJsonlObject } from './native-jsonl-read'

export interface NativeSourceSessionEnvelope {
  nativeSessionId: string
  payload: unknown
}

/**
 * A Source adapter must pass only roots obtained from its own detected
 * installation. A stale or untrusted locator is never enough to grant access.
 */
export async function hydrateNativeJsonlSourceRecord(input: {
  record: SourceRecord
  ctx: SourceRawRecoveryContext
  sourceId: string
  parserVersion: string
  allowedRoots: readonly string[]
  envelope: (entry: Record<string, unknown>, filePath: string) => Promise<NativeSourceSessionEnvelope>
}): Promise<SourceRawHydrationResult> {
  const { record, ctx, sourceId, parserVersion, allowedRoots } = input
  if (record.sourceId !== sourceId || record.installationId !== ctx.installation.id) {
    return { state: 'unsupported', reason: 'source-installation-mismatch' }
  }
  if (record.parserVersion !== parserVersion) {
    return { state: 'incompatible', reason: 'source-parser-version-changed' }
  }

  const filePath = record.locator.kind === 'file' ? record.locator.path : undefined
  if (!filePath || !isAbsolute(filePath) || extname(filePath).toLowerCase() !== '.jsonl'
    || record.locator.offset === undefined || !record.fingerprint) {
    return { state: 'unsupported', reason: 'stable-jsonl-reference-required' }
  }
  ctx.abortSignal.throwIfAborted()
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

  const result = await readVerifiedNativeJsonlObject({
    path: canonicalPath,
    offset: record.locator.offset,
    expectedFingerprint: record.fingerprint,
    abortSignal: ctx.abortSignal,
  })
  if (result.state !== 'available') {
    return {
      state: result.state,
      reason: result.reason,
      ...(result.state === 'drifted' ? { currentFingerprint: result.currentFingerprint } : {}),
    }
  }

  ctx.abortSignal.throwIfAborted()
  const hydrated = await input.envelope(result.entry, canonicalPath)
  if (record.sourceSessionNativeId && hydrated.nativeSessionId !== record.sourceSessionNativeId) {
    return { state: 'drifted', reason: 'source-native-session-identity-changed' }
  }
  return { state: 'available', record: { ...record, payload: hydrated.payload } }
}
