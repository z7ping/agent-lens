import type { LiveAttachmentService, StorageService } from '@agent-lens/core'
import { PiLiveAdapter } from './adapter'
import { resolvePiLiveResumeInput } from './resume'
import type { PiLiveRuntimeState, PiLiveService } from './types'

/** Adds AgentLens-logical-session resume/fork semantics without leaking Pi native paths upward. */
export class PiHistoryLiveAdapter extends PiLiveAdapter {
  constructor(
    service: PiLiveService,
    attachments: LiveAttachmentService,
    private readonly storage: StorageService,
  ) {
    super(service, attachments)
  }

  async resume(logicalSessionId: string): Promise<PiLiveRuntimeState> {
    return this.service.start(await resolvePiLiveResumeInput(this.storage, logicalSessionId, 'continue'))
  }

  async fork(logicalSessionId: string): Promise<PiLiveRuntimeState> {
    return this.service.start(await resolvePiLiveResumeInput(this.storage, logicalSessionId, 'fork'))
  }
}
