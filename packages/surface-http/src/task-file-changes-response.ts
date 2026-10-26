import type { TaskFileChangeRecord } from '@agent-lens/core'
import { AGENT_LENS_PROTOCOL_VERSION, type TaskFileChangesResponseDto } from '@agent-lens/protocol'

/** Shared native-only response DTO; never scans legacy SQL observations. */
export function taskFileChangesResponse(
  logicalSessionId: string,
  items: readonly TaskFileChangeRecord[],
  capture?: { workspacePath?: string | undefined; gitRootPath?: string | undefined } | null,
  options: { interactionId?: string; truncated?: boolean } = {},
): TaskFileChangesResponseDto {
  const counted = items.filter(item => item.additions !== undefined || item.deletions !== undefined)
  return {
    logicalSessionId,
    ...(options.interactionId ? { interactionId: options.interactionId } : {}),
    ...(capture?.workspacePath ? { workspacePath: capture.workspacePath } : {}),
    ...(capture?.gitRootPath ? { rootPath: capture.gitRootPath } : {}),
    items: items.map(item => ({
      path: item.path,
      changeType: item.changeType,
      ...(item.oldPath ? { oldPath: item.oldPath } : {}),
      ...(item.additions === undefined ? {} : { additions: item.additions }),
      ...(item.deletions === undefined ? {} : { deletions: item.deletions }),
      firstChangedAt: item.firstChangedAt,
      lastChangedAt: item.lastChangedAt,
      evidence: [...item.evidence],
      confidence: item.confidence,
    })),
    summary: {
      count: items.length,
      ...(counted.length ? {
        additions: counted.reduce((sum, item) => sum + (item.additions ?? 0), 0),
        deletions: counted.reduce((sum, item) => sum + (item.deletions ?? 0), 0),
      } : {}),
      exactCount: items.filter(item => item.confidence === 'exact').length,
      observedCount: items.filter(item => item.confidence !== 'exact').length,
    },
    meta: {
      protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
      generatedAt: new Date().toISOString(),
      ...(options.truncated ? { truncated: true } : {}),
    },
  }
}
