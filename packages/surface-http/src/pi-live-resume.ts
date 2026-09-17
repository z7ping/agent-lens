import type { StorageService } from '@agent-lens/core'
import {
  resolvePiLiveHistoryInput,
  type PiLiveHistoryAction,
  type PiLiveStartInput,
} from '@agent-lens/runtime-cordis'

/** Compatibility wrapper. Pi-owned history resolution now lives in the Pi Integration. */
export function resolvePiLiveResumeInput(
  storage: StorageService,
  logicalSessionId: string,
  historyAction: PiLiveHistoryAction = 'continue',
): Promise<PiLiveStartInput> {
  return resolvePiLiveHistoryInput(storage, logicalSessionId, historyAction)
}
