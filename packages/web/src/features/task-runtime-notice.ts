import type { ReviewEventNodeDto } from '@agent-lens/protocol'
import type { LiveTaskProjectionItem } from './live-task-projection'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

const ALERT_STATES = new Set([
  'error', 'failed', 'failure', 'fatal', 'warning', 'warn', 'blocked',
  'denied', 'rejected', 'unavailable', 'disconnected', 'timeout',
])

/** Only Source-provided structured status can promote an extension notice.
 * Text/emoji/tool names are never used to infer success or failure. */
function explicitAlert(value: unknown): boolean {
  const fields = record(value)
  const details = record(fields.details)
  for (const current of [fields, details]) {
    if (current.isError === true || current.hasError === true || current.failed === true) return true
    if (typeof current.error === 'string' && current.error.trim()) return true
    if (current.error !== null && typeof current.error === 'object') return true
    for (const key of ['status', 'state', 'severity', 'level', 'outcome']) {
      const status = current[key]
      if (typeof status === 'string' && ALERT_STATES.has(status.toLowerCase())) return true
    }
  }
  return false
}

/** A Pi native custom_message is extension context, not a user turn or tool call.
 * It stays in the session record even when its normal-status row is collapsed. */
export function isRoutineLiveRuntimeNotice(item: LiveTaskProjectionItem): boolean {
  return item.kind === 'native' && item.nativeType === 'custom_message'
    && item.source.type === 'custom_message' && !explicitAlert(item.source)
}

/** The canonical Review equivalent is verified by native action AND provenance.
 * A generic context.injection or an untyped/failed extension fact stays visible. */
export function isRoutineReviewRuntimeNotice(node: ReviewEventNodeDto): boolean {
  if (node.kind !== 'context.injected') return false
  const payload = record(node.payload)
  if (payload.event !== 'pi.custom_message') return false
  const provenance = record(payload.provenance)
  return provenance.sourceSignal === 'pi custom message'
    && provenance.originType === 'application-injection'
    && !explicitAlert(payload.rawPayload)
}
