import type { ReplicationAvailability } from './policy'

export type UnifiedReadOrigin =
  | {
      kind: 'local'
      nodeId: string
      entityId: string
    }
  | {
      kind: 'remote'
      nodeId: string
      entityId: string
      generationId: string
    }

export interface UnifiedReadReference {
  entityType: string
  publicId: string
}

export type UnifiedReadReferenceValue = UnifiedReadReference | readonly UnifiedReadReference[]
export type UnifiedReadReferences = Readonly<Record<string, UnifiedReadReferenceValue>>

export interface UnifiedLogicalSession {
  publicId: string
  entityType: 'LogicalSession'
  origin: UnifiedReadOrigin
  body: Readonly<Record<string, ReplicationAvailability>>
  references: UnifiedReadReferences
}

export interface UnifiedCanonicalObservation {
  publicId: string
  entityType: 'CanonicalObservation'
  origin: UnifiedReadOrigin
  body: Readonly<Record<string, ReplicationAvailability>>
  references: UnifiedReadReferences
}

export interface UnifiedLogicalSessionReader {
  get(publicId: string): Promise<UnifiedLogicalSession | undefined>
  /**
   * Deterministic local + active-generation remote session discovery.
   * Availability remains attached to fields; callers must not invent values
   * for omitted/redacted timestamps or titles.
   */
  list(limit?: number): Promise<readonly UnifiedLogicalSession[]>
}

export interface UnifiedObservationReader {
  queryForLogicalSession(
    logicalSessionPublicId: string,
    limit?: number,
  ): Promise<readonly UnifiedCanonicalObservation[]>
}

export interface UnifiedReadService {
  logicalSessions: UnifiedLogicalSessionReader
  observations: UnifiedObservationReader
}
