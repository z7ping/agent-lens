import { memo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiveMessageActionContributionDto } from '@agent-lens/protocol'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { MarkdownContent } from '../components/MarkdownContent'
import { Button } from '../components/ui'
import { liveTaskRoundEstimate, type LiveTaskProjectionItem, type LiveTaskRoundProjection } from './live-task-projection'
import { sameStableLiveTaskRoundProps } from './live-task-render-boundary'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
import { TaskProcessGroup } from './TaskProcessGroup'
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
        preview: item.text.replace(/\s+/g, ' ').trim().slice(0, 96),
        state: item.streaming ? 'running' : 'settled',
      }}
      defaultExpanded={item.streaming}
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
  />
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
    const lastIndex = projection.items.indexOf(items[items.length - 1]!)
    const hasFollowingAnswer = projection.items.slice(lastIndex + 1).some(item =>
      item.kind === 'message' && item.role === 'assistant' && item.phase !== 'commentary')
    const processState = hasFollowingAnswer ? 'settled' : projection.model.state
    // 只有来源携带时间戳时才计算执行范围，不将整个轮次耗时冒充处理耗时。
    const times = items.flatMap(item => {
      const time = Date.parse(item.at ?? '')
      return Number.isFinite(time) ? [time] : []
    })
    const startedAtMs = times.length ? Math.min(...times) : undefined
    const endedAtMs = times.length && processState !== 'running' ? Math.max(...times) : undefined
    content.push(<TaskProcessGroup
      key={`process:${items[0]!.id}`} id={`process:${items[0]!.id}`}
      messageCount={items.filter(item => item.kind === 'thinking' || item.kind === 'message').length}
      toolCount={items.filter(item => item.kind === 'tool').length}
      errorCount={items.filter(item => item.kind === 'tool' && item.status === 'error').length}
      startedAtMs={startedAtMs} endedAtMs={endedAtMs}
      thinkingDurationMs={items.reduce((sum, item) => sum + (item.kind === 'thinking' ? item.durationMs ?? 0 : 0), 0) || undefined}
      state={processState} defaultExpanded={processState === 'running'}
    >
      <div className="task-process-sequence">
        {items.map(item => item.kind === 'message' && item.phase === 'commentary'
          ? <div key={item.id} className="task-process-message" data-message-role="commentary"><MarkdownContent text={item.text} streaming={item.streaming}/></div>
          : renderItem(item))}
      </div>
    </TaskProcessGroup>)
  }
  for (const item of projection.items) {
    if (item.kind === 'thinking' || item.kind === 'tool' || (item.kind === 'message' && item.phase === 'commentary')) process.push(item)
    else { flushProcess(); content.push(renderItem(item)) }
  }
  flushProcess()
  return <VirtualRoundMount
    rootSelector=".pi-live-reader"
    flowRoot
    eager={eager}
    estimate={liveTaskRoundEstimate(projection)}
  >
    <TaskRound model={awaitingResponse ? { ...projection.model, state: 'running' } : projection.model} className="live-task-round">
      {content}
      {awaitingResponse && <TaskMessage role="assistant" text="" author={agentLabel} pending className="live-task-response-pending"/>}
    </TaskRound>
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

