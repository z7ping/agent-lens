import type {
  LiveMessageActionContributionDto,
} from '@agent-lens/protocol'
import type {
  LiveTaskProjectionItem,
  LiveTaskRoundProjection,
} from './live-task-projection'

export interface StableLiveTaskRoundProps {
  projection: LiveTaskRoundProjection
  agentLabel: string
  eager: boolean
  messageActions: readonly LiveMessageActionContributionDto[]
  actionPending: string | null
  runtimeStreaming: boolean
  onMessageAction: (
    action: LiveMessageActionContributionDto,
    item: Extract<LiveTaskProjectionItem, { kind: 'message' }>,
  ) => void
}

export function sameStableLiveTaskRoundProps(
  previous: StableLiveTaskRoundProps,
  next: StableLiveTaskRoundProps,
): boolean {
  if (previous.agentLabel !== next.agentLabel
    || previous.eager !== next.eager
    || previous.messageActions !== next.messageActions
    || previous.actionPending !== next.actionPending
    || previous.runtimeStreaming !== next.runtimeStreaming
    || previous.onMessageAction !== next.onMessageAction) return false

  const before = previous.projection
  const after = next.projection
  if (before.items.length !== after.items.length) return false
  for (let index = 0; index < before.items.length; index += 1) {
    if (before.items[index] !== after.items[index]) return false
  }

  const beforeModel = before.model
  const afterModel = after.model
  return beforeModel.id === afterModel.id
    && beforeModel.semanticId === afterModel.semanticId
    && beforeModel.ordinal === afterModel.ordinal
    && beforeModel.label === afterModel.label
    && beforeModel.state === afterModel.state
    && beforeModel.preview === afterModel.preview
    && beforeModel.toolCount === afterModel.toolCount
    && beforeModel.errorCount === afterModel.errorCount
    && beforeModel.durationMs === afterModel.durationMs
    && beforeModel.highLatency === afterModel.highLatency
}
