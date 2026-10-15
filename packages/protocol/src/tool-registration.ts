import type { TimelineEvidenceDto, TimelineItemDto } from './timeline'

/**
 * Registration evidence is a canonical fact, not a tool-name convention.
 * Sources emit tool.registration through the normal Observation/Evidence pipeline.
 *
 * Payload for "registered":
 * { registrationId, runtimeId, profileId?, nativeToolName, action: 'registered',
 *   toolSourceType, mcpServerId? }
 *
 * Payload for "removed":
 * { registrationId, runtimeId, profileId?, nativeToolName, action: 'removed' }
 *
 * The source's installationId and sourceId are inherited from its Observation.
 */
export type ToolRegistrationSourceType = 'builtin' | 'mcp' | 'plugin' | 'extension' | 'skill-runtime' | 'unknown'

/** Source adapters produce this payload via ObservationCandidate.kind=tool.registration.
 * runtimeId is the real runtime identity, not a process name or executable path.
 * The adapter must preserve its own scoped registrationId across removal.
 */
export type ToolRegistrationPayloadDto = {
  registrationId: string
  runtimeId: string
  profileId?: string
  nativeToolName: string
} & (
  | { action: 'registered'; toolSourceType: ToolRegistrationSourceType; mcpServerId?: string }
  | { action: 'removed' }
)

export interface ResolvedToolRegistration {
  toolSourceType: ToolRegistrationSourceType
  mcpServerId?: string
  registrationObservationId: string
  evidence: TimelineEvidenceDto[]
}

interface Registration {
  item: TimelineItemDto
  registrationId: string
  action: 'registered' | 'removed'
  sourceType?: ToolRegistrationSourceType
  mcpServerId?: string
  occurredMs: number
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function key(parts: string[]): string {
  // Array-encoding avoids collisions between user-provided runtime/profile/name values.
  return JSON.stringify(parts)
}

function registrationScope(item: TimelineItemDto): string | undefined {
  const payload = record(item.payload)
  const runtimeId = text(payload.runtimeId)
  const toolName = text(payload.nativeToolName)
  if (!runtimeId || !toolName) return undefined
  const profileId = text(payload.profileId) ?? ''
  return key([item.installationId, item.sourceId, item.logicalSessionId, runtimeId, profileId, toolName])
}

function callScope(item: TimelineItemDto): string | undefined {
  const payload = record(item.payload)
  const runtimeId = text(payload.runtimeId)
  const toolName = text(payload.nativeToolName)
  if (!runtimeId || !toolName) return undefined
  const profileId = text(payload.profileId) ?? ''
  return key([item.installationId, item.sourceId, item.logicalSessionId, runtimeId, profileId, toolName])
}

function trustworthy(item: TimelineItemDto): boolean {
  // Inferred/estimated evidence cannot authorize tool provenance.
  return item.evidence.some(value =>
    (value.derivation === 'observed' || value.derivation === 'reported')
    && (value.confidence === 'exact' || value.confidence === 'high')
    && (value.captureMethod === 'runtime-hook' || value.captureMethod === 'native-log' || value.captureMethod === 'native-db')
  )
}

function registration(item: TimelineItemDto): Registration | undefined {
  if (item.kind !== 'tool.registration' || !trustworthy(item)) return undefined
  const payload = record(item.payload)
  const registrationId = text(payload.registrationId)
  const action = payload.action
  const occurredMs = Date.parse(item.effectiveAt)
  if (!registrationId || (action !== 'registered' && action !== 'removed') || !Number.isFinite(occurredMs)) return undefined
  const sourceType = payload.toolSourceType
  if (action === 'registered' && !['builtin', 'mcp', 'plugin', 'extension', 'skill-runtime', 'unknown'].includes(String(sourceType))) return undefined
  const mcpServerId = text(payload.mcpServerId)
  if (action === 'registered' && sourceType === 'mcp' && !mcpServerId) return undefined
  return {
    item,
    registrationId,
    action,
    ...(action === 'registered' ? { sourceType: sourceType as ToolRegistrationSourceType } : {}),
    ...(mcpServerId ? { mcpServerId } : {}),
    occurredMs,
  }
}

/** Resolve only registrations present in the supplied canonical Timeline window.
 * A missing earlier registration is unknown; current machine configuration must
 * never retroactively label historical calls. A conflict is also unknown.
 */
export class ToolRegistrationIndex {
  private readonly scopes = new Map<string, Registration[]>()
  private readonly uncertainSince = new Map<string, number>()

  constructor(items: readonly TimelineItemDto[]) {
    for (const item of items) {
      const scope = registrationScope(item)
      if (!scope || item.kind !== 'tool.registration') continue
      const parsed = registration(item)
      if (!parsed) {
        // A malformed or untrusted change might be a removal; carrying forward
        // the previous owner would be a false positive.
        const at = Date.parse(item.effectiveAt)
        if (Number.isFinite(at)) {
          const first = this.uncertainSince.get(scope)
          this.uncertainSince.set(scope, first === undefined ? at : Math.min(first, at))
        }
        continue
      }
      const rows = this.scopes.get(scope) ?? []
      rows.push(parsed)
      this.scopes.set(scope, rows)
    }
    for (const rows of this.scopes.values()) {
      rows.sort((a, b) => a.occurredMs - b.occurredMs || a.item.id.localeCompare(b.item.id))
    }
  }

  resolve(call: TimelineItemDto): ResolvedToolRegistration | undefined {
    if (call.kind !== 'tool.call') return undefined
    const scope = callScope(call)
    if (!scope) return undefined
    const callMs = Date.parse(call.effectiveAt)
    if (!Number.isFinite(callMs)) return undefined
    const uncertainSince = this.uncertainSince.get(scope)
    if (uncertainSince !== undefined && uncertainSince <= callMs) return undefined

    const active = new Map<string, Registration>()
    for (const row of this.scopes.get(scope) ?? []) {
      // Same-timestamp records have no guaranteed happened-before relationship.
      if (row.occurredMs >= callMs) break
      if (row.action === 'removed') active.delete(row.registrationId)
      else active.set(row.registrationId, row)
    }
    if (active.size !== 1) return undefined
    const only = active.values().next().value as Registration | undefined
    if (!only?.sourceType || only.sourceType === 'unknown') return undefined
    return {
      toolSourceType: only.sourceType,
      ...(only.sourceType === 'mcp' && only.mcpServerId ? { mcpServerId: only.mcpServerId } : {}),
      registrationObservationId: only.item.id,
      evidence: only.item.evidence,
    }
  }
}
