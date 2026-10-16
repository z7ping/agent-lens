import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReviewEventNodeDto, ReviewInteractionDto, ReviewMessageAttachmentDto, ReviewMessageNodeDto, ReviewNodeDto, ReviewProcessSummaryDto, ReviewToolNodeDto } from '@agent-lens/protocol'
import { agentLabel } from '../components/AgentScope'
import { AgentLensApi } from '../client/api'
import { TaskFileChangesDisclosure } from './TaskFileChangesDisclosure'
import type { TaskFileChangesResponseDto } from '@agent-lens/protocol'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { MarkdownContent } from '../components/MarkdownContent'
import { type ToolVisualKind } from '../components/ToolKindIcon'
import { UiIcon } from '../components/ui'
import { projectReviewInteractionPresentation, projectReviewInteractionToolStats, projectReviewMessageModelLabels, type ReviewInteractionPresentationEntry, type ReviewProcessPresentationItem } from './review-interaction-presentation'
import { reviewEventLabel } from './review-event-presentation'
import { TaskEvent } from './TaskEvent'
import { TaskMessage } from './TaskMessage'
import { TaskProcessGroup } from './TaskProcessGroup'
import { TaskRound } from './TaskRound'
import { TaskThinking } from './TaskThinking'
import { TaskToolGroup } from './TaskToolGroup'
import { agentLensI18n } from '../i18n/runtime'
import { type TaskRoundModel, type TaskThinkingModel, type TaskToolGroupModel, type TaskToolModel } from './task-detail-model'
import { formatClock, duration, elapsed } from './review-session-format'
import { brief, EvidenceBadges, sourceEventSummary, toolKindLabel, toolPresentation, toolOutputText } from './ReviewEvidenceInspector'

const taskFileApi = new AgentLensApi()

function MarkdownSurface({ text }: { text: string }) {
  const { t } = useTranslation('review')
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  const [collapsedHeight, setCollapsedHeight] = useState<number | undefined>()
  const surfaceRef = useRef<HTMLDivElement>(null)

  const measure = useCallback(() => {
    const element = surfaceRef.current
    if (!element) return
    const style = window.getComputedStyle(element)
    const fontSize = Number.parseFloat(style.fontSize) || 14
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.65
    const limit = Math.ceil(lineHeight * 5 + 2)
    setCollapsedHeight(limit)
    setCollapsible(element.scrollHeight > limit + 2)
  }, [])

  useLayoutEffect(() => {
    setExpanded(false)
    const element = surfaceRef.current
    if (!element) return
    const frame = window.requestAnimationFrame(measure)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [measure, text, view])

  return <div className="markdown-message" data-view={view}>
    <div
      ref={surfaceRef}
      className={`markdown-surface ${collapsible && !expanded ? 'is-collapsed' : ''}`}
      style={collapsible && !expanded && collapsedHeight ? { maxHeight: `${collapsedHeight}px` } : undefined}
    >
      {view === 'rendered' ? <MarkdownContent text={text}/> : <CopyableCodeBlock className="markdown-source" copyValue={text}>{text}</CopyableCodeBlock>}
      {collapsible && !expanded && <span className="markdown-fade" aria-hidden="true"/>}
    </div>
    <div className="markdown-message-actions">
      {collapsible && <button onClick={() => setExpanded(value => !value)}>{expanded ? t('local.markdown.collapseFiveLines') : t('local.markdown.expand')}</button>}
      <button title={view === 'rendered' ? t('local.markdown.viewSource') : t('local.markdown.returnRendered')} onClick={() => setView(value => value === 'rendered' ? 'source' : 'rendered')}>{view === 'rendered' ? t('local.markdown.source') : t('local.markdown.rendered')}</button>
    </div>
  </div>
}

function MessageBubble({
  node,
  inspect,
  loadAttachments,
  nestedTools = [],
  modelLabel,
}: {
  node: ReviewMessageNodeDto
  inspect(node: ReviewNodeDto): void
  loadAttachments(observationId: string): Promise<ReviewMessageAttachmentDto[]>
  nestedTools?: ReviewToolNodeDto[]
  modelLabel?: string | undefined
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
    return <TaskThinking
      model={thinking}
      defaultExpanded={false}
      meta={<EvidenceBadges evidence={node.evidence} compact/>}
      actions={node.evidence.length > 0 ? <button className="evidence-link" onClick={() => inspect(node)}>{t('local.evidence.allEvidence', { count: node.evidence.length })}</button> : undefined}
    >
      <MarkdownSurface text={node.text}/>
      {nestedTools.length > 0 && <ReviewToolGroupAdapter items={nestedTools} inspect={inspect}/>} 
    </TaskThinking>
  }

  return <TaskMessage
    role={node.role === 'user' ? 'user' : 'assistant'}
    text={node.text}
    attachments={attachments}
    author={node.role === 'user' ? t('local.role.you') : agentLabel(node.sourceId)}
    modelLabel={node.role === 'assistant' ? modelLabel : undefined}
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
  const { i18n } = useTranslation('review')
  const localeRevision = i18n.resolvedLanguage ?? i18n.language
  const model = useMemo<TaskToolGroupModel>(() => {
    const tools = items.map(reviewToolModel)
    const errorCount = tools.filter(tool => tool.status === 'error').length
    const totalDuration = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
    const counts = new Map<ToolVisualKind, number>()
    for (const tool of tools) counts.set(tool.kind, (counts.get(tool.kind) ?? 0) + 1)
    return {
      id: `tools:${items.map(item => item.id).join(':')}`,
      label: agentLensI18n.t('review:local.tool.execution'),
      itemCount: tools.length,
      errorCount,
      totalDurationLabel: totalDuration > 0 ? duration(totalDuration) : undefined,
      kindCounts: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([kind, count]) => ({ kind, label: toolKindLabel(kind), count })),
      tools,
    }
  }, [items, localeRevision])
  const nodes = useMemo(() => new Map(items.map(node => [node.id, node] as const)), [items])
  return <TaskToolGroup
    model={model}
    renderMeta={tool => {
      const node = nodes.get(tool.id)
      return node ? <EvidenceBadges evidence={node.evidence} compact/> : null
    }}
    onToolClick={tool => {
      const node = nodes.get(tool.id)
      if (node) inspect(node)
    }}
  />
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
  const timing = reviewProcessTiming(items)
  const partial = summary?.availability === 'partial'
  return <TaskProcessGroup
    id={id}
    messageCount={summary?.messageCount ?? messages.length}
    toolCount={summary?.toolCount ?? tools.length}
    errorCount={summary?.errorCount ?? tools.filter(tool => tool.status === 'error').length}
    durationMs={summary?.durationMs}
    startedAtMs={summary ? undefined : timing.startedAtMs}
    endedAtMs={summary ? undefined : state === 'running' ? undefined : timing.endedAtMs}
    state={state}
    defaultExpanded={false}
    expansionStore={expansionStore}
    onExpandedChange={onExpandedChange}
    summaryExtra={partial ? <span>{t('local.process.partial')}</span> : undefined}
    className="task-review-process"
  >
    {loadState === 'idle' && <div className="task-process-loading">{t('local.process.expandToLoad')}</div>}
    {loadState === 'loading' && <div className="task-process-loading">{t('local.process.loading')}</div>}
    {loadState === 'error' && <div className="task-process-load-error" role="alert">
      <span>{loadError || t('local.process.loadFailed')}</span>
      {onRetry && <button type="button" onClick={onRetry}>{t('local.roundNav.loadFailedRetry')}</button>}
    </div>}
    {loadState === 'loaded' && <div className="task-process-sequence">
      {items.map((item, index) => {
        if (item.type === 'tool-group') return <div key={`tools-${index}`} data-reasoning-parent={item.parentReasoningId}><ReviewToolGroupAdapter items={item.items} inspect={inspect}/></div>
        if (item.type === 'event') return <EventRow key={item.node.id} event={item.node} inspect={inspect}/>
        if (item.type === 'raw-event-group') return showAllEvents ? <RawEventGroup key={`raw-${index}`} items={item.items} inspect={inspect}/> : null
        if (item.node.role === 'reasoning') return <TaskThinking
          key={item.node.id}
          model={{ id: item.node.id, label: t('local.process.thinking'), text: item.node.text, preview: item.node.text.replace(/\s+/g, ' ').trim().slice(0, 220), state: 'settled' }}
          className="task-process-thinking-card"
          defaultExpanded={false}
          expansionStore={expansionStore}
        >
          <MarkdownSurface text={item.node.text}/>
        </TaskThinking>
        return <div className="task-process-message" data-message-role={item.node.role} key={item.node.id}>
          <span className="task-process-message-label">{t('local.process.output')}</span>
          <MarkdownSurface text={item.node.text}/>
        </div>
      })}
    </div>}
  </TaskProcessGroup>
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
  />
}

function RawEventGroup({ items, inspect }: { items: ReviewEventNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  const { t } = useTranslation('review')
  const [expanded, setExpanded] = useState(false)
  return <details className="raw-event-group" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>
      <UiIcon className="raw-event-group-chevron" name="chevron-right" size={14}/>
      <span className="raw-event-summary-copy">
        <span className="raw-event-summary-title">{t('local.rawEvents.title')} <span className="raw-event-summary-count">{items.length}</span></span>
      </span>
      <time>{formatClock(items[items.length - 1]?.at ?? '')}</time>
    </summary>
    {expanded && <div>{items.map(item => <EventRow key={item.id} event={item} inspect={inspect}/>)}</div>}
  </details>
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
    preview: brief(user?.text ?? '', 86),
  }
}

export function ReviewRoundAdapter({
  sessionId,
  interaction,
  round,
  inspect,
  loadAttachments,
  loadProcess,
  defaultExpanded,
  expansionStore,
  forceExpanded,
  forceRevision,
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
  defaultExpanded: boolean
  expansionStore: Map<string, boolean>
  forceExpanded: boolean
  forceRevision: number
  showAllEvents: boolean
  onShowAllEvents: () => void
  fileChangesEnabled?: boolean
}) {
  const { t } = useTranslation('review')
  const [roundFileChanges, setRoundFileChanges] = useState<TaskFileChangesResponseDto | null>(null)
  useEffect(() => {
    if (!fileChangesEnabled) return
    const controller = new AbortController()
    void taskFileApi.reviewInteractionFileChanges(sessionId, {
      id: interaction.id,
      startedAt: interaction.startedAt,
      endedAt: interaction.endedAt,
    }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setRoundFileChanges(value) })
      .catch(() => { if (!controller.signal.aborted) setRoundFileChanges(null) })
    return () => controller.abort()
  }, [fileChangesEnabled, sessionId, interaction.id, interaction.startedAt, interaction.endedAt])
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
  const effectiveSummary = loadedProcess?.processSummary ?? summary
  const groups = useMemo(() => projectReviewInteractionPresentation(effectiveInteraction.nodes), [effectiveInteraction.nodes])
  const modelLabels = useMemo(() => projectReviewMessageModelLabels(effectiveInteraction.nodes), [effectiveInteraction.nodes])
  const processEntry = groups.find((entry): entry is Extract<ReviewInteractionPresentationEntry, { type: 'process' }> => entry.type === 'process')
  const promptEntries = groups.filter(entry => entry.type === 'message' && entry.node.role === 'user')
  const afterProcessEntries = groups.filter(entry => !(entry.type === 'message' && entry.node.role === 'user') && entry.type !== 'process')
  const hasFinalAnswer = afterProcessEntries.some(entry => entry.type === 'message' && entry.node.role === 'assistant')
  // 只统计当前已经加载的原始事件，避免把未展开的惰性过程误报为 0。
  const unknownCount = groups.reduce((sum, entry) => sum + (entry.type === 'raw-event-group'
    ? entry.items.length : entry.type === 'process'
      ? entry.items.reduce((total, item) => total + (item.type === 'raw-event-group' ? item.items.length : 0), 0)
      : 0), 0)
  const resolvedProcessState = hasFinalAnswer ? 'settled' : round.state

  const renderEntry = (entry: ReviewInteractionPresentationEntry, index: number) => {
    if (entry.type === 'tool-group') return <ReviewToolGroupAdapter key={`tools-${index}`} items={entry.items} inspect={inspect}/>
    if (entry.type === 'raw-event-group') return showAllEvents ? <RawEventGroup key={`raw-${index}`} items={entry.items} inspect={inspect}/> : null
    if (entry.type === 'reasoning') return <MessageBubble key={entry.node.id} node={entry.node} nestedTools={entry.tools} inspect={inspect} loadAttachments={loadAttachments}/>
    if (entry.type === 'message') return <MessageBubble key={entry.node.id} node={entry.node} inspect={inspect} loadAttachments={loadAttachments} modelLabel={modelLabels.get(entry.node.id)}/>
    if (entry.type === 'event') return <EventRow key={entry.node.id} event={entry.node} inspect={inspect}/>
    return null
  }

  const processGroup = effectiveSummary?.itemCount
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

  return <TaskRound
    model={round}
    defaultExpanded={defaultExpanded}
    expansionStore={expansionStore}
    forceExpanded={forceExpanded}
    forceRevision={forceRevision}
  >
    {promptEntries.map(renderEntry)}
    {processGroup}
    {afterProcessEntries.map(renderEntry)}
    {fileChangesEnabled && roundFileChanges?.interactionId === interaction.id && roundFileChanges.summary.count > 0 && <TaskFileChangesDisclosure value={roundFileChanges}/>}
    {!showAllEvents && unknownCount > 0 && <button type="button" className="review-unknown-count" onClick={onShowAllEvents}>
      <UiIcon name="exclamation" size={14}/>{t('local.rawEvents.hiddenCount', { count: unknownCount })}
    </button>}
  </TaskRound>
}

