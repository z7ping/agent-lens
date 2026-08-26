import type {
  CanonicalObservation,
  CommitObservationInput,
  ObservationCommitResult,
  ObservationQuery,
  ObservationService,
} from '@agent-lens/core'
import type { AgentLensContext } from './context'

export class EventingObservationService implements ObservationService {
  constructor(
    private readonly inner: ObservationService,
    private readonly ctx: AgentLensContext,
  ) {}

  async commit(input: CommitObservationInput): Promise<ObservationCommitResult> {
    const result = await this.inner.commit(input)
    if (result.status !== 'unchanged') {
      this.ctx.emit('observation/committed', {
        observationId: result.observation.id,
        logicalSessionId: result.observation.logicalSessionId,
        status: result.status,
      })
    }
    return result
  }

  get(id: string): Promise<CanonicalObservation | null> {
    return this.inner.get(id)
  }

  query(query: ObservationQuery): Promise<CanonicalObservation[]> {
    return this.inner.query(query)
  }
}
