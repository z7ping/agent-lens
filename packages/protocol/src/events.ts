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
