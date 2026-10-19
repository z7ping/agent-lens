import { memo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiveMessageActionContributionDto } from '@agent-lens/protocol'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { MarkdownContent } from '../components/MarkdownContent'
import { Button } from '../components/ui'
import { liveTaskRoundEstimate, type LiveTaskProjectionItem, type LiveTaskRoundProjection } from './live-task-projection'
import { sameStableLiveTaskRoundProps } from './live-task-render-boundary'
import { TaskMessage } from './TaskMessage'
import type { TaskRoundModel } from './task-detail-model'
import { LiveToolGroup } from './LiveToolGroup'
import { TaskThinking } from './TaskThinking'
import { TaskToolRow } from './TaskToolRow'

/** 仅负责将统一 Live 投影映射到共享 TaskSurface 组件，无订阅与发送副作用。 */
function contributionText(
  value: LiveMessageActionContributionDto['label'],
  language: string,
): string {
  const normalized = language.replace(/_/g, '-').toLowerCase()
  const localized = Object.entries(value.localizations ?? {})
    .find(([locale]) => locale.toLowerCase() === normalized)?.[1]
  return localized || value.default
}

function GenericLiveItem({
  item,
  agentLabel,
  messageActions,
  actionPending,
  runtimeStreaming,
  onMessageAction,
}: {
  item: LiveTaskProjectionItem
  agentLabel: string
  messageActions: readonly LiveMessageActionContributionDto[]
  actionPending: string | null
  runtimeStreaming: boolean
  onMessageAction(action: LiveMessageActionContributionDto, item: Extract<LiveTaskProjectionItem, { kind: 'message' }>): void
}) {
  const { t, i18n } = useTranslation('task')
  if (item.kind === 'message') {
    const actions = item.entryId
      ? messageActions.filter(action => action.roles.includes(item.role))
      : []
    return <TaskMessage
      role={item.role}
      text={item.text}
      attachments={item.attachments}
      author={item.role === 'assistant' ? agentLabel : undefined}
      streaming={item.streaming}
      actions={actions.length
        ? actions.map(action => {
            const key = `${action.actionId}:${item.entryId}`
            const disabled = actionPending !== null || (action.requiresIdle === true && runtimeStreaming)
            const description = action.description ? contributionText(action.description, i18n.language) : undefined
            return <Button
              key={action.actionId}
              size="small"
              disabled={disabled}
              title={description}
              onClick={() => onMessageAction(action, item)}
            >
              {actionPending === key ? t('live.messageActionPending') : contributionText(action.label, i18n.language)}
            </Button>
          })
        : undefined}
    />
  }
  if (item.kind === 'thinking') {
    return <TaskThinking
      model={{
        id: item.id,
        label: t('thinking.thinkingProcess'),
        ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
        text: item.text,
        preview: item.text.replace(/\s+/g, ' ').trim().slice(0, 220),
        state: item.streaming ? 'running' : 'settled',
      }}
      defaultExpanded={false}
      className="task-process-thinking-card"
    >
      <MarkdownContent text={item.text} streaming={item.streaming}/>
    </TaskThinking>
  }
  return <TaskToolRow
    model={{
      id: item.id,
      name: item.name,
      kind: 'tool',
      kindLabel: t('tool.kind.tool'),
      ...(item.toolSourceType ? { toolSourceType: item.toolSourceType } : {}),
      ...(item.mcpServerId ? { mcpServerId: item.mcpServerId } : {}),
      status: item.status,
      primary: item.inputPreview,
      output: item.output,
      durationMs: item.durationMs,
    }}
    compact
  />
}

/** Live uses semantic rounds only for navigation/virtualization; never a visible disclosure. */
export function LiveTranscriptRound({ model, children }: { model: TaskRoundModel; children: ReactNode }) {
  return <div
    className="live-task-transcript-round interaction-block"
    data-interaction-id={model.id}
    data-round-semantic-id={model.semanticId ?? model.id}
    data-round-label={model.label}
    data-round-preview={model.preview || undefined}
    data-round-error={model.errorCount > 0 ? 'true' : undefined}
    data-round-state={model.state}
  >{children}</div>
}

export const GenericLiveRound = memo(function GenericLiveRound({
  projection,
  agentLabel,
  eager,
  messageActions,
  actionPending,
  runtimeStreaming,
  showResponsePending = false,
  onMessageAction,
}: {
  projection: LiveTaskRoundProjection
  agentLabel: string
  eager: boolean
  showResponsePending?: boolean
  messageActions: readonly LiveMessageActionContributionDto[]
  actionPending: string | null
  runtimeStreaming: boolean
  onMessageAction(action: LiveMessageActionContributionDto, item: Extract<LiveTaskProjectionItem, { kind: 'message' }>): void
}) {
  const awaitingResponse = showResponsePending
    && projection.items.some(item => item.kind === 'message' && item.role === 'user')
    && !projection.items.some(item => item.kind === 'thinking'
      || item.kind === 'tool'
      || (item.kind === 'message' && item.role === 'assistant'))
  const content: ReactNode[] = []
  let process: LiveTaskProjectionItem[] = []
  const renderItem = (item: LiveTaskProjectionItem) => <GenericLiveItem
    key={item.id} item={item} agentLabel={agentLabel} messageActions={messageActions}
    actionPending={actionPending} runtimeStreaming={runtimeStreaming} onMessageAction={onMessageAction}
  />
  const flushProcess = () => {
    if (!process.length) return
    const items = process
    process = []
    if (items.some(item => item.kind === 'tool')) {
      content.push(<LiveToolGroup key={`tools:${items[0]!.id}`} items={items} renderItem={renderItem}/>)
    } else {
      // Reasoning-only stages remain one folded line, without a redundant tool header.
      for (const item of items) content.push(renderItem(item))
    }
  }
  for (const item of projection.items) {
    if (item.kind === 'thinking' || item.kind === 'tool') process.push(item)
    else { flushProcess(); content.push(renderItem(item)) }
  }
  flushProcess()
  return <VirtualRoundMount
    rootSelector=".pi-live-reader"
    flowRoot
    eager={eager}
    estimate={liveTaskRoundEstimate(projection)}
  >
    <LiveTranscriptRound model={awaitingResponse ? { ...projection.model, state: 'running' } : projection.model}>
      {content}
      {awaitingResponse && <TaskMessage role="assistant" text="" author={agentLabel} pending className="live-task-response-pending"/>}
    </LiveTranscriptRound>
  </VirtualRoundMount>
}, sameStableLiveTaskRoundProps)

export const StableLiveRounds = memo(function StableLiveRounds({
  rounds,
  agentLabel,
  eagerTailCount,
  messageActions,
  actionPending,
  runtimeStreaming,
  onMessageAction,
}: {
  rounds: readonly LiveTaskRoundProjection[]
  agentLabel: string
  eagerTailCount: number
  messageActions: readonly LiveMessageActionContributionDto[]
  actionPending: string | null
  runtimeStreaming: boolean
  onMessageAction(action: LiveMessageActionContributionDto, item: Extract<LiveTaskProjectionItem, { kind: 'message' }>): void
}) {
  return <>
    {rounds.map((round, index) => <GenericLiveRound
      key={round.model.id}
      projection={round}
      agentLabel={agentLabel}
      eager={index >= rounds.length - eagerTailCount}
      messageActions={messageActions}
      actionPending={actionPending}
      runtimeStreaming={runtimeStreaming}
      onMessageAction={onMessageAction}
    />)}
  </>
})

