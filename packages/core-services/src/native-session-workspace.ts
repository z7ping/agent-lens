import { isAbsolute, normalize } from 'node:path'
import type { SourceRecord } from '@agent-lens/core'

/** Only trusted Source session metadata may identify the local working directory.
 * Never derive a workspace from message text or an AgentLens storage file path.
 */
export function nativeSessionWorkspacePath(record: SourceRecord): string | undefined {
  const payload = record.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const session = (payload as Record<string, unknown>).session
  if (!session || typeof session !== 'object' || Array.isArray(session)) return undefined
  const raw = (session as Record<string, unknown>).cwd
  if (typeof raw !== 'string') return undefined
  const path = raw.trim()
  return path && path.length <= 4096 && isAbsolute(path) ? normalize(path) : undefined
}
