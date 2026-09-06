export type LiveUpdateArea = 'review' | 'sessions' | 'usage' | 'agents' | 'insights'

export interface ObservationCommittedEventDto {
  type: 'observation.committed'
  observationId: string
  logicalSessionId?: string
  installationId?: string
  projectId?: string
  sourceId?: string
  affected: LiveUpdateArea[]
  emittedAt: string
}

export interface AgentChangedEventDto {
  type: 'agent.changed'
  sourceId?: string
  installationId?: string
  assetBindingId?: string
  affected: ['agents']
  emittedAt: string
}

export type LiveUpdateEventDto = ObservationCommittedEventDto | AgentChangedEventDto

const LIVE_UPDATE_AREAS = ['review', 'sessions', 'usage', 'agents', 'insights'] as const

function eventRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Live update event must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !value) throw new TypeError(`Live update event ${key} must be a non-empty string`)
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`Live update event ${key} must be a string`)
  return value
}

function affectedAreas(value: unknown): LiveUpdateArea[] {
  if (!Array.isArray(value)) throw new TypeError('Live update event affected must be an array')
  const result: LiveUpdateArea[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !(LIVE_UPDATE_AREAS as readonly string[]).includes(item)) {
      throw new TypeError(`Live update event affected contains unsupported area: ${String(item)}`)
    }
    result.push(item as LiveUpdateArea)
  }
  return result
}

export function parseLiveUpdateEvent(value: unknown): LiveUpdateEventDto {
  const record = eventRecord(value)
  const type = record.type
  const emittedAt = requiredString(record, 'emittedAt')

  if (type === 'observation.committed') {
    const logicalSessionId = optionalString(record, 'logicalSessionId')
    const installationId = optionalString(record, 'installationId')
    const projectId = optionalString(record, 'projectId')
    const sourceId = optionalString(record, 'sourceId')
    return {
      type,
      observationId: requiredString(record, 'observationId'),
      ...(logicalSessionId === undefined ? {} : { logicalSessionId }),
      ...(installationId === undefined ? {} : { installationId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(sourceId === undefined ? {} : { sourceId }),
      affected: affectedAreas(record.affected),
      emittedAt,
    }
  }

  if (type === 'agent.changed') {
    const affected = affectedAreas(record.affected)
    if (affected.length !== 1 || affected[0] !== 'agents') {
      throw new TypeError('agent.changed affected must contain only agents')
    }
    const sourceId = optionalString(record, 'sourceId')
    const installationId = optionalString(record, 'installationId')
    const assetBindingId = optionalString(record, 'assetBindingId')
    return {
      type,
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(installationId === undefined ? {} : { installationId }),
      ...(assetBindingId === undefined ? {} : { assetBindingId }),
      affected: ['agents'],
      emittedAt,
    }
  }

  throw new TypeError(`Unsupported live update event type: ${String(type)}`)
}
