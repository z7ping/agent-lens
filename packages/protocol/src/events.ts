export type LiveUpdateArea = 'review' | 'sessions' | 'usage' | 'agents'

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

export type LiveUpdateEventDto = ObservationCommittedEventDto
