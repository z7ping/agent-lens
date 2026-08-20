export interface ObservationCommittedEventDto {
  type: 'observation.committed'
  observationId: string
  emittedAt: string
}

export type LiveUpdateEventDto = ObservationCommittedEventDto
