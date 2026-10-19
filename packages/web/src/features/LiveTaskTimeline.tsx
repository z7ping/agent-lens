import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiveMessageActionContributionDto } from '@agent-lens/protocol'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { Button } from '../components/ui'
import { liveTaskRoundEstimate, type LiveTaskProjectionItem, type LiveTaskRoundProjection } from './live-task-projection'
import { sameStableLiveTaskRoundProps } from './live-task-render-boundary'
import { TaskReadingRound } from './TaskReadingRound'
import { TaskSessionMessage, TaskSessionThinking, TaskSessionTool, TaskSessionProcessText, TaskSessionProcess } from './TaskSessionContent'
import { projectTaskReading, type TaskReadingFact } from './task-reading-semantics'

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
  showContentActions = false,
  onMessageAction,
}: {
  item: LiveTaskProjectionItem
  agentLabel: string
  messageActions: readonly LiveMessageActionContributionDto[]
  actionPending: string | null
  runtimeStreaming: boolean
  showContentActions?: boolean
  onMessageAction(action: LiveMessageActionContributionDto, item: Extract<LiveTaskProjectionItem, { kind: 'message' }>): void
}) {
  const { t, i18n } = useTranslation('task')
  if (item.kind === 'message') {
    const actions = item.entryId
      ? messageActions.filter(action => action.roles.includes(item.role))
      : []
    return <TaskSessionMessage
      role={item.role}
      text={item.text}
      attachments={item.attachments}
      author={item.role === 'assistant' ? agentLabel : undefined}
      streaming={item.streaming}
      showContentActions={showContentActions}
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
    return <TaskSessionThinking
      model={{
        id: item.id,
        label: t('thinking.thinkingProcess'),
        ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
        text: item.text,
        preview: item.text.replace(/\s+/g, ' ').trim().slice(0, 220),
        state: item.streaming ? 'running' : 'settled',
      }}
      streaming={item.streaming}
    />
  }
  return <TaskSessionTool model={{
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
  }}/>

}

/** Exactly one answer-action owner per semantic round, even when its final
 * fragment contains only terminal/tool facts and no assistant message. */
export function liveRoundOwnsAnswerActions(
  rounds: readonly LiveTaskRoundProjection[],
  index: number,
): boolean {
  const round = rounds[index]
  if (!round) return false
  const hasAnswer = (candidate: LiveTaskRoundProjection) => candidate.items.some(item =>
    item.kind === 'message' && item.role === 'assistant' && item.phase !== 'commentary')
  if (!hasAnswer(round)) return false
  const semanticId = round.model.semanticId ?? round.model.id
  return !rounds.slice(index + 1).some(candidate =>
    (candidate.model.semanticId ?? candidate.model.id) === semanticId && hasAnswer(candidate))
}

export const GenericLiveRound = memo(function GenericLiveRound({
  projection,
  agentLabel,
  eager,
  messageActions,
  actionPending,
  runtimeStreaming,
  showResponsePending = false,
  showAnswerActions = true,
  onMessageAction,
}: {
  projection: LiveTaskRoundProjection
  agentLabel: string
  eager: boolean
  showResponsePending?: boolean
  showAnswerActions?: boolean
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
  // Only native commentary/reasoning/tool stages enter processing.
  // Unknown-phase assistant text stays visible; never infer a final from prose.
  const reading = projectTaskReading(projection.items.map(item => {
    const kind: TaskReadingFact<LiveTaskProjectionItem>['kind'] = item.kind === 'thinking'
      ? 'reasoning'
      : item.kind === 'tool' ? 'tool'
        : item.role === 'user' ? 'prompt'
          : item.phase === 'commentary' ? 'commentary'
            : item.phase === 'final' ? 'answer' : 'unclassified-answer'
    return { id: item.id, kind, value: item, ...(item.kind === 'tool' && item.status === 'error' ? { error: true } : {}) }
  }))
  const processItems = reading.process.map(fact => fact.value)
  const visibleItems = [...reading.prompts, ...reading.answers, ...reading.auxiliary].map(fact => fact.value)
  const lastAnswerId = reading.answers.at(-1)?.id
  const renderItem = (item: LiveTaskProjectionItem) => <GenericLiveItem
    key={item.id} item={item} agentLabel={agentLabel} messageActions={messageActions}
    actionPending={actionPending} runtimeStreaming={runtimeStreaming}
    showContentActions={item.kind === 'message' && item.role === 'assistant'
      && item.id === lastAnswerId && projection.model.state !== 'running' && showAnswerActions}
    onMessageAction={onMessageAction}
  />
  const renderProcessItem = (item: LiveTaskProjectionItem) =>
    item.kind === 'message'
      ? <TaskSessionProcessText key={item.id} text={item.text} streaming={item.streaming}/>
      : renderItem(item)
  // Every native event keeps its position in the single Process disclosure.
  // TaskToolRow already owns each tool's input/output toggle; grouping adds
  // an unnecessary second disclosure and hides successful calls.
  const processContent = processItems.map(renderProcessItem)

  const processCount = reading.processCounts.commentary
  const thinkingCount = reading.processCounts.thinking
  const toolCount = reading.processCounts.tools
  const processTimes = processItems.flatMap(item => {
    const at = Date.parse(item.at ?? '')
    return Number.isFinite(at) ? [at] : []
  })
  const startedAtMs = processTimes.length ? Math.min(...processTimes) : undefined
  const processState = projection.model.state
  const endedAtMs = processTimes.length && processState !== 'running'
    ? Math.max(...processTimes) : undefined
  const process = processItems.length > 0 && <TaskSessionProcess
    mode="live"
    key={`process:${projection.model.id}`}
    id={`process:${projection.model.id}`}
    messageCount={processCount}
    thinkingCount={thinkingCount}
    toolCount={toolCount}
    errorCount={reading.processCounts.errors}
    startedAtMs={startedAtMs}
    endedAtMs={endedAtMs}
    thinkingDurationMs={processItems.reduce((sum, item) =>
      sum + (item.kind === 'thinking' ? item.durationMs ?? 0 : 0), 0) || undefined}
    state={processState}
  ><div className="task-process-sequence">{processContent}</div></TaskProcessGroup>

  const prompt = visibleItems.filter(item => item.kind === 'message' && item.role === 'user').map(renderItem)
  const answer = visibleItems.filter(item => item.kind === 'message' && item.role === 'assistant').map(renderItem)
  return <VirtualRoundMount
    rootSelector=".pi-live-reader"
    flowRoot
    eager={eager}
    estimate={liveTaskRoundEstimate(projection)}
  >
    <TaskReadingRound
      model={awaitingResponse ? { ...projection.model, state: 'running' } : projection.model}
      prompt={prompt}
      process={process}
      answer={<>
        {answer}
        {awaitingResponse && <TaskSessionMessage role="assistant" text="" author={agentLabel} pending className="live-task-response-pending"/>}
      </>}
    />
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
      showAnswerActions={liveRoundOwnsAnswerActions(rounds, index)}
      messageActions={messageActions}
      actionPending={actionPending}
      runtimeStreaming={runtimeStreaming}
      onMessageAction={onMessageAction}
    />)}
  </>
})

