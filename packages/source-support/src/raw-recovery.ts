import { createHash } from 'node:crypto'
import { readJsonlLines } from './source-jsonl'

export interface JsonlFingerprintVerification {
  state: 'verified' | 'unavailable' | 'drifted' | 'unsupported'
  currentFingerprint?: string
  reason?: string
}

export async function verifyJsonlLineSha256(input: {
  path?: string
  offset?: number
  expectedFingerprint?: string
}): Promise<JsonlFingerprintVerification> {
  if (!input.path || input.offset === undefined || !input.expectedFingerprint) {
    return {
      state: 'unsupported',
      reason: 'stable-file-path-offset-and-fingerprint-required',
    }
  }

  try {
    for await (const line of readJsonlLines(input.path, input.offset)) {
      if (line.startOffset !== input.offset) {
        return {
          state: 'drifted',
          reason: 'source-offset-no-longer-points-to-original-line',
        }
      }
      const currentFingerprint = createHash('sha256').update(line.text).digest('hex')
      return currentFingerprint === input.expectedFingerprint
        ? { state: 'verified', currentFingerprint }
        : {
            state: 'drifted',
            currentFingerprint,
            reason: 'source-content-fingerprint-changed',
          }
    }
    return {
      state: 'unavailable',
      reason: 'source-line-no-longer-available',
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      return {
        state: 'unavailable',
        reason: code === 'ENOENT'
          ? 'source-file-missing'
          : 'source-file-not-readable',
      }
    }
    throw error
  }
}
