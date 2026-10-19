import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReviewEventNodeDto, ReviewInteractionDto, ReviewMessageAttachmentDto, ReviewMessageNodeDto, ReviewNodeDto, ReviewProcessSummaryDto, ReviewToolNodeDto, TaskFileChangesResponseDto } from '@agent-lens/protocol'
import { agentLabel } from '../components/AgentScope'
import { AgentLensApi } from '../client/api'
import { TaskFileChangesDisclosure } from './TaskFileChangesDisclosure'
import { UiIcon } from '../components/ui'
import { projectReviewInteractionPresentation, projectReviewInteractionToolStats, projectReviewMessageModelLabels, type ReviewInteractionPresentationEntry, type ReviewProcessPresentationItem } from './review-interaction-presentation'
import { isConsolidatedFileChangeEvent, isFailedLifecycleEvent, isSessionTitleUpdate, reviewEventLabel } from './review-event-presentation'
import { TaskEvent } from './TaskEvent'
import { TaskReadingRound } from './TaskReadingRound'
import { projectTaskReading, type TaskReadingFact } from './task-reading-semantics'
import { TaskThinking } from './TaskThinking'
import { TaskSessionMessage, TaskSessionThinking, TaskSessionTool, TaskSessionProcessText, TaskSessionProcess } from './TaskSessionContent'
import { agentLensI18n } from '../i18n/runtime'
import { taskUserRequestText, type TaskRoundModel, type TaskThinkingModel, type TaskToolModel } from './task-detail-model'
import { formatClock, duration, elapsed } from './review-session-format'
import { brief, EvidenceBadges, sourceEventSummary, toolPresentation, toolOutputText } from './ReviewEvidenceInspector'

const taskFileApi = new AgentLensApi()

function MessageBubble({
  node,
  inspect,
  loadAttachments,
  nestedTools = [],
  modelLabel,
  showContentActions = false,
}: {
  node: ReviewMessageNodeDto
  inspect(node: ReviewNodeDto): void
  loadAttachments(observationId: string): Promise<ReviewMessageAttachmentDto[]>
  nestedTools?: ReviewToolNodeDto[]
  modelLabel?: string | undefined
  showContentActions?: boolean | undefined
}) {
  const { t } = useTranslation('review')
  const [attachments, setAttachments] = useState<ReviewMessageAttachmentDto[]>(node.attachments ?? [])

  useEffect(() => {
    setAttachments(node.attachments ?? [])
    if (node.role === 'reasoning' || node.role === 'commentary') return
    if (!(node.attachments ?? []).some(item => item.type === 'image')) return
    let active = true
    void loadAttachments(node.id).then(
      items => { if (active) setAttachments(items) },
      () => undefined,
    )
    return () => { active = false }
  }, [loadAttachments, node.attachments, node.id, node.role])

  if (node.role === 'reasoning' || node.role === 'commentary') {
    const label = node.role === 'commentary' ? t('local.process.execution') : t('local.process.thinking')
    const thinking: TaskThinkingModel = {
      id: node.id,
      label,
      text: node.text,
      preview: node.text.replace(/\s+/g, ' ').trim().slice(0, 220),
      time: formatClock(node.at),
      state: 'settled',
    }
    return <TaskSessionThinking
      model={thinking}
      meta={<EvidenceBadges evidence={node.evidence} compact/>}
      actions={node.evidence.length > 0 ? <button className="evidence-link" onClick={() => inspect(node)}>{t('local.evidence.allEvidence', { count: node.evidence.length })}</button> : undefined}
      nested={nestedTools.length > 0 ? <ReviewToolGroupAdapter items={nestedTools} inspect={inspect}/> : undefined}
    />
  }

  return <TaskSessionMessage
    role={node.role === 'user' ? 'user' : 'assistant'}
    text={node.role === 'user' && node.sourceId === 'codex' ? taskUserRequestText(node.text) : node.text}
    attachments={attachments}
    author={node.role === 'user' ? t('local.role.you') : agentLabel(node.sourceId)}
    modelLabel={node.role === 'assistant' ? modelLabel : undefined}
    showContentActions={node.role === 'assistant' && showContentActions}
    time={formatClock(node.at)}
    meta={<EvidenceBadges evidence={node.evidence}/>}
    actions={node.evidence.length > 0 ? <button onClick={() => inspect(node)}>{t('local.evidence.evidenceDetail', { count: node.evidence.length })}</button> : undefined}
  />
}

function reviewToolModel(node: ReviewToolNodeDto): TaskToolModel {
  const info = toolPresentation(node)
  const status = node.status === 'error' ? 'error' : node.status === 'success' ? 'success' : node.status === 'running' ? 'running' : 'unknown'
  return {
    id: node.id,
    name: node.name,
    kind: info.kind,
    kindLabel: info.label,
    ...(node.toolSourceType ? { toolSourceType: node.toolSourceType } : {}),
    ...(node.mcpServerId ? { mcpServerId: node.mcpServerId } : {}),
    status,
    primary: info.primary || undefined,
    secondary: info.secondary || undefined,
    ...(node.input === undefined ? {} : { rawInput: typeof node.input === 'string' ? node.input : JSON.stringify(node.input, null, 2) ?? '' }),
    ...(node.output === undefined ? {} : { output: toolOutputText(node.output) }),
    ...(node.durationMs !== undefined && Number.isFinite(node.durationMs) && node.durationMs >= 0
      ? { durationMs: node.durationMs } : {}),
  }
}

function ReviewToolGroupAdapter({ items, inspect }: { items: ReviewToolNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  return <>{items.map(node => <TaskSessionTool
    key={node.id}
    model={reviewToolModel(node)}
    meta={<EvidenceBadges evidence={node.evidence} compact/>}
    onInspect={() => inspect(node)}
  />)}</>
}

function processTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function reviewProcessTiming(items: ReviewProcessPresentationItem[]): { startedAtMs?: number; endedAtMs?: number } {
  let startedAtMs: number | undefined
  let endedAtMs: number | undefined
  let running = false

  const include = (start: number | undefined, end = start) => {
    if (start !== undefined) startedAtMs = startedAtMs === undefined ? start : Math.min(startedAtMs, start)
    if (end !== undefined) endedAtMs = endedAtMs === undefined ? end : Math.max(endedAtMs, end)
  }

  for (const item of items) {
    if (item.type === 'message' || item.type === 'event') {
      include(processTimestamp(item.node.at))
      continue
    }
    if (item.type === 'raw-event-group') {
      for (const event of item.items) include(processTimestamp(event.at))
      continue
    }
    for (const tool of item.items) {
      const start = processTimestamp(tool.startedAt) ?? processTimestamp(tool.at)
      const explicitEnd = processTimestamp(tool.endedAt)
      const computedEnd = explicitEnd ?? (start !== undefined && tool.durationMs !== undefined ? start + tool.durationMs : start)
      include(start, computedEnd)
      if (tool.status === 'running') running = true
    }
  }

  return {
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
    ...(running || endedAtMs === undefined ? {} : { endedAtMs }),
  }
}

function ReviewProcessGroup({
  id,
  items,
  summary,
  inspect,
  state,
  showAllEvents,
  loadState = 'loaded',
  loadError = '',
  expansionStore,
  onExpandedChange,
  onRetry,
}: {
  id: string
  items: ReviewProcessPresentationItem[]
  summary?: ReviewProcessSummaryDto
  inspect(node: ReviewNodeDto): void
  state: TaskRoundModel['state']
  showAllEvents: boolean
  loadState?: 'idle' | 'loading' | 'loaded' | 'error'
  loadError?: string
  expansionStore?: Map<string, boolean>
  onExpandedChange?: (expanded: boolean) => void
  onRetry?: () => void
}) {
  const { t } = useTranslation('review')
  const messages = items.filter((item): item is Extract<typeof item, { type: 'message' }> => item.type === 'message')
  const tools = items.flatMap(item => item.type === 'tool-group' ? item.items : [])
  const thinkingCount = messages.filter(item => item.node.role === 'reasoning').length
  const commentaryCount = messages.filter(item => item.node.role === 'commentary').length
  const timing = reviewProcessTiming(items)
  const degraded = summary?.availability === 'partial' || summary?.availability === 'unavailable'
    || summary?.availability === 'truncated'
  const unavailable = summary?.availability === 'unavailable'
  const reasonLabel = summary?.reasonCode ? t(`local.process.reasons.${summary.reasonCode}`) : undefined
  return <TaskSessionProcess
    mode="review"
    id={id}
    messageCount={items.length ? commentaryCount : 0}
    thinkingCount={items.length ? thinkingCount : undefined}
    toolCount={summary?.toolCount ?? tools.length}
    errorCount={summary?.errorCount ?? tools.filter(tool => tool.status === 'error').length}
    durationMs={summary?.durationMs}
    startedAtMs={summary ? undefined : timing.startedAtMs}
    endedAtMs={summary ? undefined : state === 'running' ? undefined : timing.endedAtMs}
    state={state}
    expansionStore={expansionStore}
    onExpandedChange={onExpandedChange}
    summaryExtra={degraded ? <span>{t(`local.process.${summary?.availability}`)}{reasonLabel ? ` · ${reasonLabel}` : ''}</span> : undefined}
  >
    {loadState === 'idle' && <div className="task-process-loading">{t('local.process.expandToLoad')}</div>}
    {loadState === 'loading' && <div className="task-process-loading">{t('local.process.loading')}</div>}
    {loadState === 'error' && <div className="task-process-load-error" role="alert">
      <span>{loadError || t('local.process.loadFailed')}</span>
      {onRetry && <button type="button" onClick={onRetry}>{t('local.roundNav.loadFailedRetry')}</button>}
    </div>}
    {loadState === 'loaded' && unavailable && <div className="task-process-loading" role="status">{reasonLabel ?? t('local.process.unavailable')}</div>}
    {loadState === 'loaded' && !unavailable && <div className="task-process-sequence">
      {items.map((item, index) => {
        if (item.type === 'tool-group') return <ReviewToolGroupAdapter key={`tools-${index}`} items={item.items} inspect={inspect}/>
        if (item.type === 'event') return <EventRow key={item.node.id} event={item.node} inspect={inspect}/>
        if (item.type === 'raw-event-group') return showAllEvents ? <RawEventGroup key={`raw-${index}`} items={item.items} inspect={inspect}/> : null
        if (item.node.role === 'reasoning') return <TaskSessionThinking
          key={item.node.id}
          model={{
            id: item.node.id,
            label: t('local.process.thinking'),
            text: item.node.text,
            preview: item.node.text.replace(/\s+/g, ' ').trim().slice(0, 220),
            state: 'settled',
          }}
          expansionStore={expansionStore}
        />
        return <TaskSessionProcessText key={item.node.id} text={item.node.text}/>
      })}
    </div>}
  </TaskSessionProcess>
}

function EventRow({ event, inspect }: { event: ReviewEventNodeDto; inspect(node: ReviewNodeDto): void }) {
  return <TaskEvent
    model={{
      id: event.id,
      label: reviewEventLabel(event),
      category: event.category,
      summary: sourceEventSummary(event),
      sourceLabel: agentLabel(event.sourceId),
      time: formatClock(event.at),
      nativeId: event.nativeEventId,
      parentId: event.nativeParentEventId ?? event.parentObservationId,
    }}
    meta={<EvidenceBadges evidence={event.evidence} compact/>}
    onInspect={() => inspect(event)}
    error={isFailedLifecycleEvent(event)}
  />
}

function RawEventGroup({ items, inspect, runtime = false }: { items: ReviewEventNodeDto[]; inspect(node: ReviewNodeDto): void; runtime?: boolean }) {
  const { t } = useTranslation('review')
  return <TaskThinking
    model={{ id: `runtime-records:${items[0]?.id}`, label: t(runtime ? 'local.rawEvents.runtime' : items.every(isSessionTitleUpdate) ? 'local.rawEvents.titleUpdates' : 'local.rawEvents.title'), text: '', state: 'settled' }}
    kind="process"
    className="task-process-group"
    defaultExpanded={false}
    meta={<span className="task-process-summary"><span>{t('local.rawEvents.recordCount', { count: items.length })}</span></span>}
  >
    {items.map(item => <EventRow key={item.id} event={item} inspect={inspect}/>)}
  </TaskThinking>
}

interface InteractionStats {
  toolCount: number
  errorCount: number
  durationMs: number
  preview: string
}

export function interactionStats(interaction: ReviewInteractionDto): InteractionStats {
  const user = interaction.nodes.find((node): node is ReviewMessageNodeDto => node.type === 'message' && node.role === 'user')
  const toolStats = projectReviewInteractionToolStats(interaction)
  return {
    ...toolStats,
    durationMs: elapsed(interaction.startedAt, interaction.endedAt),
    preview: brief(user?.sourceId === 'codex' ? taskUserRequestText(user.text) : user?.text ?? '', 86),
  }
}

export function ReviewRoundAdapter({
  sessionId,
  interaction,
  round,
  inspect,
  loadAttachments,
  loadProcess,
  expansionStore,
  showAllEvents,
  onShowAllEvents,
  fileChangesEnabled,
}: {
  sessionId: string
  interaction: ReviewInteractionDto
  round: TaskRoundModel
  inspect(node: ReviewNodeDto): void
  loadAttachments(observationId: string): Promise<ReviewMessageAttachmentDto[]>
  loadProcess(sessionId: string, ordinal: number, revision: string, signal?: AbortSignal): Promise<ReviewInteractionDto | null>
  expansionStore: Map<string, boolean>
  showAllEvents: boolean
  onShowAllEvents: () => void
  fileChangesEnabled?: boolean
}) {
  const { t } = useTranslation('review')
  const [roundFileChanges, setRoundFileChanges] = useState<TaskFileChangesResponseDto | null>(null)
  const fileChangeObservationIds = useMemo(() => interaction.nodes.flatMap(node =>
    node.type === 'event' && node.kind === 'artifact.action' ? node.observationIds : []), [interaction.nodes])
  useEffect(() => {
    if (!fileChangesEnabled) return
    const controller = new AbortController()
    void taskFileApi.reviewInteractionFileChanges(sessionId, {
      id: interaction.id,
      startedAt: interaction.startedAt,
      endedAt: interaction.endedAt,
      observationIds: fileChangeObservationIds,
    }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setRoundFileChanges(value) })
      .catch(() => { if (!controller.signal.aborted) setRoundFileChanges(null) })
    return () => controller.abort()
  }, [fileChangesEnabled, sessionId, interaction.id, interaction.startedAt, interaction.endedAt, fileChangeObservationIds])
  const summary = interaction.processSummary
  const lazy = interaction.processMode === 'summary' && Boolean(summary?.itemCount)
  const [loadedProcess, setLoadedProcess] = useState<ReviewInteractionDto | null>(lazy ? null : interaction)
  const [processLoadState, setProcessLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>(lazy ? 'idle' : 'loaded')
  const [processLoadError, setProcessLoadError] = useState('')
  const processAbortRef = useRef<AbortController | null>(null)

  const startProcessLoad = useCallback((targetSummary: ReviewProcessSummaryDto) => {
    processAbortRef.current?.abort()
    const controller = new AbortController()
    processAbortRef.current = controller
    setProcessLoadState('loading')
    setProcessLoadError('')
    void loadProcess(sessionId, interaction.ordinal, targetSummary.revision, controller.signal).then(
      result => {
        if (controller.signal.aborted) return
        if (processAbortRef.current === controller) processAbortRef.current = null
        if (!result) {
          setProcessLoadState('error')
          setProcessLoadError(agentLensI18n.t('review:local.process.loadFailed'))
          return
        }
        setLoadedProcess(result)
        setProcessLoadState('loaded')
      },
      error => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
        if (processAbortRef.current === controller) processAbortRef.current = null
        setProcessLoadState('error')
        setProcessLoadError(error instanceof Error ? error.message : String(error))
      },
    )
  }, [interaction.ordinal, loadProcess, sessionId])

  useEffect(() => {
    processAbortRef.current?.abort()
    processAbortRef.current = null
    setLoadedProcess(lazy ? null : interaction)
    setProcessLoadError('')
    if (lazy && summary && expansionStore.get(summary.id) === true) {
      startProcessLoad(summary)
    } else {
      setProcessLoadState(lazy ? 'idle' : 'loaded')
    }
    return () => processAbortRef.current?.abort()
  }, [interaction.id, interaction.processMode, summary?.revision, lazy, expansionStore, startProcessLoad])

  const requestProcess = useCallback(() => {
    if (!lazy || !summary || processLoadState === 'loading' || loadedProcess) return
    startProcessLoad(summary)
  }, [lazy, loadedProcess, processLoadState, startProcessLoad, summary])

  const cancelProcess = () => {
    if (processLoadState !== 'loading') return
    processAbortRef.current?.abort()
    processAbortRef.current = null
    setProcessLoadState('idle')
  }

  const effectiveInteraction = loadedProcess ?? interaction
  // A successful Detail fetch cannot turn an already incomplete source into
  // "complete" merely because a bounded response happened to be returned.
  const fetchedSummary = loadedProcess?.processSummary
  const sourceDegraded = summary && !['complete', 'available'].includes(summary.availability)
  const fetchedComplete = fetchedSummary && ['complete', 'available'].includes(fetchedSummary.availability)
  const effectiveSummary = sourceDegraded && fetchedComplete
    ? { ...fetchedSummary, availability: summary.availability, ...(summary.reasonCode ? { reasonCode: summary.reasonCode } : {}) }
    : fetchedSummary ?? summary
  const groups = useMemo(() => projectReviewInteractionPresentation(effectiveInteraction.nodes), [effectiveInteraction.nodes])
  const modelLabels = useMemo(() => projectReviewMessageModelLabels(effectiveInteraction.nodes), [effectiveInteraction.nodes])
  const reading = useMemo(() => projectTaskReading(groups.map((entry, index) => {
    const id = entry.type === 'message' || entry.type === 'reasoning' || entry.type === 'event'
      ? entry.node.id
      : entry.type === 'process' ? entry.id : `${entry.type}:${index}`
    const kind: TaskReadingFact<ReviewInteractionPresentationEntry>['kind'] = entry.type === 'process'
      ? 'process-block'
      : entry.type === 'message'
        ? entry.node.role === 'user' ? 'prompt'
          : entry.node.role === 'assistant' ? 'unclassified-answer'
            : entry.node.role === 'reasoning' ? 'reasoning' : 'commentary'
        : entry.type === 'reasoning' ? 'reasoning'
          : entry.type === 'tool-group' ? 'tool' : 'auxiliary'
    return { id, kind, value: entry }
  })), [groups])
  const processEntry = reading.process.map(fact => fact.value).find(
    (entry): entry is Extract<ReviewInteractionPresentationEntry, { type: 'process' }> => entry.type === 'process',
  )
  const promptEntries = reading.prompts.map(fact => fact.value)
  // Preserve actual post-process event order and provenance, including approvals/errors.
  const afterProcessEntries = groups.filter(entry =>
    !(entry.type === 'message' && entry.node.role === 'user') && entry.type !== 'process')
  const lastAssistantEntry = [...reading.answers].reverse().map(fact => fact.value).find(
    (entry): entry is Extract<ReviewInteractionPresentationEntry, { type: 'message' }> =>
      entry.type === 'message' && entry.node.role === 'assistant',
  )
  const lastAssistantId = lastAssistantEntry?.node.id
  const hasFinalAnswer = Boolean(lastAssistantId)
  // 只统计当前已经加载的原始事件，避免把未展开的惰性过程误报为 0。
  const unknownCount = groups.reduce((sum, entry) => sum + (entry.type === 'raw-event-group'
    ? entry.items.filter(item => item.category === 'unknown').length : entry.type === 'process'
      ? entry.items.reduce((total, item) => total + (item.type === 'raw-event-group' ? item.items.filter(event => event.category === 'unknown').length : 0), 0)
      : 0), 0)
  const resolvedProcessState = hasFinalAnswer ? 'settled' : round.state
  // 仅收起当前轮次卡片确实涵盖的文件事件；不能因为会话级汇总覆盖就隐藏原始证据。
  const isConsolidatedEvent = (event: ReviewEventNodeDto) => isConsolidatedFileChangeEvent(
    event, roundFileChanges?.interactionId === interaction.id ? roundFileChanges : null,
  )
  const consolidatedEvents = afterProcessEntries.flatMap(entry => entry.type === 'event' && isConsolidatedEvent(entry.node) ? [entry.node] : [])
  // Single collapsed auxiliary group per round. Keep actual event nodes, IDs,
  // timestamps and Evidence links; do not mix unknown or failed events into it.
  const runtimeRecords = afterProcessEntries.flatMap(entry =>
    entry.type === 'runtime-event-group'
      || entry.type === 'raw-event-group' && entry.items.every(isSessionTitleUpdate)
      ? entry.items : [])

  const renderEntry = (entry: ReviewInteractionPresentationEntry, index: number) => {
    if (entry.type === 'tool-group') return <ReviewToolGroupAdapter key={`tools-${index}`} items={entry.items} inspect={inspect}/>
    if (entry.type === 'runtime-event-group') return null
    if (entry.type === 'raw-event-group') {
      if (entry.items.every(isSessionTitleUpdate)) return null
      return showAllEvents ? <RawEventGroup key={`raw-${index}`} items={entry.items} inspect={inspect}/> : null
    }
    if (entry.type === 'reasoning') return <MessageBubble key={entry.node.id} node={entry.node} nestedTools={entry.tools} inspect={inspect} loadAttachments={loadAttachments}/>
    if (entry.type === 'message') return <MessageBubble key={entry.node.id} node={entry.node} inspect={inspect} loadAttachments={loadAttachments} modelLabel={modelLabels.get(entry.node.id)} showContentActions={entry.node.id === lastAssistantId}/>
    if (entry.type === 'event') {
      if (isConsolidatedEvent(entry.node)) return null
      return <EventRow key={entry.node.id} event={entry.node} inspect={inspect}/>
    }
    return null
  }

  const processGroup = (effectiveSummary?.itemCount || (effectiveSummary && !['complete', 'available'].includes(effectiveSummary.availability)))
    ? <ReviewProcessGroup
        id={effectiveSummary.id}
        items={processEntry?.items ?? []}
        summary={effectiveSummary}
        inspect={inspect}
        state={resolvedProcessState}
        showAllEvents={showAllEvents}
        expansionStore={expansionStore}
        loadState={lazy ? processLoadState : 'loaded'}
        loadError={processLoadError}
        onExpandedChange={expanded => expanded ? requestProcess() : cancelProcess()}
        onRetry={requestProcess}
      />
    : processEntry
      ? <ReviewProcessGroup id={processEntry.id} items={processEntry.items} inspect={inspect} state={resolvedProcessState} showAllEvents={showAllEvents} expansionStore={expansionStore}/>
      : null

  return <TaskReadingRound
    model={round}
    prompt={promptEntries.map(renderEntry)}
    process={processGroup}
    answer={afterProcessEntries.map(renderEntry)}
    footer={<>
      {fileChangesEnabled && roundFileChanges?.interactionId === interaction.id && (roundFileChanges.summary.count > 0 || roundFileChanges.meta.truncated) && <TaskFileChangesDisclosure value={roundFileChanges}/>}
      {runtimeRecords.length > 0 && <RawEventGroup items={runtimeRecords} inspect={inspect} runtime/>}
      {showAllEvents && consolidatedEvents.length > 0 && <RawEventGroup items={consolidatedEvents} inspect={inspect}/>}
      {!showAllEvents && unknownCount > 0 && <button type="button" className="review-unknown-count" onClick={onShowAllEvents}>
        <UiIcon name="exclamation" size={14}/>{t('local.rawEvents.hiddenCount', { count: unknownCount })}
      </button>}
    </>}
  />
}

