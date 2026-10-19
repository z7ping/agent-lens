import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { LiveHistoryEventSummaryDto, LiveHistoryIndexItemDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { MarkdownContent } from '../components/MarkdownContent'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { toolVisualKind } from '../components/ToolKindIcon'
import { UiIcon } from '../components/UiIcon'
import { TaskEvent } from './TaskEvent'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
import { TaskProcessGroup } from './TaskProcessGroup'
import { TaskThinking } from './TaskThinking'
import { TaskToolGroup, type TaskToolGroupSequenceEntry } from './TaskToolGroup'
import type { TaskEventCategory, TaskRoundModel, TaskToolGroupModel, TaskToolKind, TaskToolModel } from './task-detail-model'
import { omitPiLivePromptMessages, type PiLiveHistoryItem } from './pi-live-history'
import { projectPiLiveTurnItems, type PiLiveTaskRoundProjection } from './pi-live-task-projection'

function formatClock(value: string, locale: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function timestamp(value: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toolKindLabel(kind: TaskToolKind, t: TFunction): string {
  return t(`task:tool.kind.${kind}`)
}

function taskTool(
  name: string,
  id: string,
  status: TaskToolModel['status'],
  summary: string,
  output: string,
  rawInput: string | undefined,
  timing: { durationMs?: number | undefined; startedAtMs?: number | undefined } | undefined,
  origin: { toolSourceType?: TaskToolModel['toolSourceType']; mcpServerId?: string },
  t: TFunction,
): TaskToolModel {
  const visualKind = toolVisualKind(name, { sourceType: origin.toolSourceType, mcpServerId: origin.mcpServerId })
  const kind: TaskToolKind = visualKind === 'test' ? 'tool' : visualKind
  return {
    id,
    name,
    kind,
    kindLabel: t(`task:tool.kind.${kind}`),
    ...(origin.toolSourceType ? { toolSourceType: origin.toolSourceType } : {}),
    ...(origin.mcpServerId ? { mcpServerId: origin.mcpServerId } : {}),
    status,
    primary: summary || undefined,
    ...(rawInput ? { rawInput } : {}),
    output: output || undefined,
    durationMs: timing?.durationMs,
    startedAtMs: timing?.startedAtMs,
  }
}

function toolGroup(id: string, tools: TaskToolModel[], t: TFunction): TaskToolGroupModel {
  const counts = new Map<TaskToolKind, number>()
  for (const tool of tools) counts.set(tool.kind, (counts.get(tool.kind) ?? 0) + 1)
  return {
    id,
    label: t('piLive:history.toolExecution'),
    itemCount: tools.length,
    errorCount: tools.filter(tool => tool.status === 'error').length,
    kindCounts: [...counts.entries()].map(([kind, count]) => ({ kind, label: toolKindLabel(kind, t), count })),
    tools,
  }
}

type HistoryTool = Extract<PiLiveHistoryItem, { kind: 'tool' }>
type HistoryToolGroup = { kind: 'tool-group'; id: string; items: HistoryTool[] }
type HistoryProcessItem = PiLiveHistoryItem | HistoryToolGroup
type HistoryRenderEntry = PiLiveHistoryItem | { kind: 'process'; id: string; items: HistoryProcessItem[] }

export function piLiveLifecycleSummary(entry: Extract<PiLiveHistoryItem, { kind: 'lifecycle' }>): string {
  if (entry.event !== 'session.info') return entry.detail
  return entry.detail.replace(/\s*·\s*Pi\s*$/, '').trim()
}

export function hasPiLiveResponseActivity(items: PiLiveHistoryItem[]): boolean {
  return items.some(item =>
    (item.kind === 'message' && item.role === 'assistant')
    || item.kind === 'thinking'
    || item.kind === 'tool'
  )
}

function historyEntries(items: PiLiveHistoryItem[]): HistoryRenderEntry[] {
  const presented = items.every(item => item.turnSection !== undefined) ? items : projectPiLiveTurnItems(items)
  const result: HistoryRenderEntry[] = []
  let processItems: HistoryProcessItem[] = []
  let tools: HistoryTool[] = []

  const flushTools = () => {
    if (!tools.length) return
    processItems.push({ kind: 'tool-group', id: `tools:${tools.map(tool => tool.id).join(':')}`, items: tools })
    tools = []
  }
  const flushProcess = () => {
    flushTools()
    if (!processItems.length) return
    const first = processItems[0]!
    result.push({ kind: 'process', id: `process:${first.id}`, items: processItems })
    processItems = []
  }

  for (const item of presented) {
    if (item.turnSection === 'process') {
      if (item.kind === 'tool') {
        tools.push(item)
        continue
      }
      flushTools()
      processItems.push(item)
      continue
    }
    flushProcess()
    result.push(item)
  }
  flushProcess()
  return result
}

function ThinkingMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <MarkdownContent text={text} streaming={streaming}/>
}

function HistoryUsageEvent({ entry }: { entry: Extract<PiLiveHistoryItem, { kind: 'usage' }> }) {
  const { t, i18n } = useTranslation('piLive')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const cost = entry.usage.cost?.total
  const summary = t('history.usageSummary', {
    input: entry.usage.inputTokens.toLocaleString(locale),
    output: entry.usage.outputTokens.toLocaleString(locale),
    cacheRead: entry.usage.cacheReadTokens.toLocaleString(locale),
    cacheWrite: entry.usage.cacheWriteTokens.toLocaleString(locale),
    total: entry.usage.totalTokens.toLocaleString(locale),
    cost: cost !== undefined ? ` · ${cost.toFixed(4)}` : '',
  })
  return <TaskEvent model={{ id: entry.id, label: t('history.usage'), category: 'usage', summary, time: entry.at ? formatClock(entry.at, locale) : undefined, nativeType: entry.nativeType, parentId: entry.parentId }} raw={entry.raw}/>
}

function piLiveEventCategory(event: string): TaskEventCategory {
  if (event === 'artifact.action') return 'artifact'
  if (event === 'native.unknown') return 'unknown'
  if (event.startsWith('model.') || event.startsWith('thinking.level.')) return 'model'
  if (event.startsWith('context.')) return 'context'
  if (event.startsWith('permission.')) return 'permission'
  if (event.startsWith('subagent.')) return 'subagent'
  return 'lifecycle'
}

function HistoryLifecycleEvent({ entry, showAllEvents }: { entry: Extract<PiLiveHistoryItem, { kind: 'lifecycle' }>; showAllEvents: boolean }) {
  const { i18n } = useTranslation('piLive')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  if (entry.event === 'native.unknown' && !showAllEvents) return null
  const summary = piLiveLifecycleSummary(entry)
  return <TaskEvent model={{
    id: entry.id,
    label: entry.label,
    category: piLiveEventCategory(entry.event),
    summary: summary || undefined,
    time: entry.at ? formatClock(entry.at, locale) : undefined,
    nativeType: entry.nativeType,
    parentId: entry.parentId,
  }} raw={entry.raw}/>
}

function processTiming(items: HistoryProcessItem[]): { startedAtMs?: number; endedAtMs?: number } {
  let startedAtMs: number | undefined
  let endedAtMs: number | undefined
  const include = (start: number | undefined, end = start) => {
    if (start !== undefined) startedAtMs = startedAtMs === undefined ? start : Math.min(startedAtMs, start)
    if (end !== undefined) endedAtMs = endedAtMs === undefined ? end : Math.max(endedAtMs, end)
  }
  for (const item of items) {
    if (item.kind === 'tool-group') {
      for (const tool of item.items) {
        const start = tool.startedAtMs ?? timestamp(tool.at)
        include(start, start !== undefined && tool.durationMs !== undefined ? start + tool.durationMs : start)
      }
      continue
    }
    include(timestamp(item.at))
  }
  return {
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
    ...(endedAtMs === undefined ? {} : { endedAtMs }),
  }
}

/** Add up only fully measured native reasoning blocks. Partial/legacy history
 * must not masquerade as a complete thinking duration. */
function measuredThinkingDuration(items: HistoryProcessItem[]): number | undefined {
  const thinking = items.filter((item): item is Extract<PiLiveHistoryItem, { kind: 'thinking' }> => item.kind === 'thinking')
  if (!thinking.length || thinking.some(item => item.durationMs === undefined || !Number.isFinite(item.durationMs) || item.durationMs < 0)) return undefined
  return thinking.reduce((total, item) => total + item.durationMs!, 0)
}

/** One progressive tool visibility boundary for each Pi process, even when
 * native thinking/commentary splits the underlying tool segments. */
function HistoryProcessSequence({
  id, items, settled = false, showAllEvents = false, expansionStore,
}: {
  id: string
  items: HistoryProcessItem[]
  settled?: boolean
  showAllEvents?: boolean
  expansionStore?: Map<string, boolean> | undefined
}) {
  const { t } = useTranslation(['piLive', 'task'])
  const sequence: TaskToolGroupSequenceEntry[] = items.flatMap(item => {
    if (item.kind === 'tool-group') return item.items.map(tool => ({
      type: 'tool' as const,
      key: tool.id,
      tool: taskTool(
        tool.name, tool.id,
        settled && tool.status === 'running' ? 'unknown' : tool.status,
        tool.summary, tool.output, tool.rawInput,
        { durationMs: tool.durationMs, startedAtMs: tool.startedAtMs },
        { ...(tool.toolSourceType ? { toolSourceType: tool.toolSourceType } : {}),
          ...(tool.mcpServerId ? { mcpServerId: tool.mcpServerId } : {}) }, t,
      ),
    }))
    if (item.kind === 'thinking') return [{
      type: 'content' as const, key: item.id,
      content: <TaskThinking
        model={{ id: item.id, label: t('task:thinking.thinkingProcess'), text: item.text,
          state: !settled && item.state === 'running' ? 'running' : 'settled' }}
        className="task-process-thinking-card" defaultExpanded={false} expansionStore={expansionStore}
      ><ThinkingMarkdown text={item.text} streaming={!settled && item.state === 'running'}/></TaskThinking>,
    }]
    if (item.kind === 'message') return [{
      type: 'content' as const, key: item.id,
      content: <div className="task-process-message" data-message-role="commentary">
        <div className="task-process-message-kind">{t('piLive:history.commentary')}</div>
        <ThinkingMarkdown text={item.text} streaming={!settled && item.state === 'running'}/>
      </div>,
    }]
    if (item.kind === 'usage') return [{
      type: 'content' as const, key: item.id, content: <HistoryUsageEvent entry={item}/>,
    }]
    if (item.kind === 'lifecycle') return [{
      type: 'content' as const, key: item.id,
      content: <HistoryLifecycleEvent entry={item} showAllEvents={showAllEvents}/>,
    }]
    return []
  })
  const models = sequence.flatMap(entry => entry.type === 'tool' ? [entry.tool] : [])
  return <TaskToolGroup compact sequence={sequence} model={toolGroup(id, models, t)}/>
}

function HistoryProcessGroup({
  id,
  items,
  state,
  showAllEvents,
  durationMs,
}: {
  id: string
  items: HistoryProcessItem[]
  state: TaskRoundModel['state']
  showAllEvents: boolean
  durationMs?: number | undefined
}) {
  const { t } = useTranslation('piLive')
  const messages = items.filter(item => item.kind === 'thinking' || (item.kind === 'message' && item.role === 'assistant'))
  const tools = items.flatMap(item => item.kind === 'tool-group' ? item.items : [])
  const timing = processTiming(items)

  return <TaskProcessGroup
    id={id}
    messageCount={messages.length}
    toolCount={tools.length}
    errorCount={tools.filter(tool => tool.status === 'error').length}
    durationMs={durationMs}
    thinkingDurationMs={measuredThinkingDuration(items)}
    startedAtMs={timing.startedAtMs}
    endedAtMs={state === 'running' ? undefined : timing.endedAtMs}
    state={state}
  >
    <div className="task-process-sequence">
      <HistoryProcessSequence id={id} items={items} settled={state !== 'running'} showAllEvents={showAllEvents}/>
    </div>
  </TaskProcessGroup>
}

function HistoryEntries({
  items,
  showAllEvents = false,
  processState = 'settled',
  assistantModelLabel,
  processDurationMs,
}: {
  items: PiLiveHistoryItem[]
  showAllEvents?: boolean
  processState?: TaskRoundModel['state']
  assistantModelLabel?: string | undefined
  processDurationMs?: number | undefined
}) {
  const { t, i18n } = useTranslation(['piLive', 'task'])
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const entries = historyEntries(items)
  const hasFinal = entries.some(entry => entry.kind === 'message' && entry.role === 'assistant' && entry.turnSection === 'final')
  const resolvedProcessState = hasFinal ? 'settled' : processState
  return <>{entries.map(entry => {
    if (entry.kind === 'message') {
      return <TaskMessage
        key={entry.id}
        role={entry.role}
        text={entry.text}
        attachments={entry.attachments}
        author={entry.role === 'user' ? t('piLive:history.user') : 'Pi'}
        modelLabel={entry.role === 'assistant' ? entry.modelLabel ?? assistantModelLabel : undefined}
        time={entry.at ? formatClock(entry.at, locale) : undefined}
        streaming={entry.role === 'assistant' && entry.state === 'running'}
        className="pi-live-task-message"
      />
    }
    if (entry.kind === 'process') return <HistoryProcessGroup key={entry.id} id={entry.id} items={entry.items} state={resolvedProcessState} showAllEvents={showAllEvents} durationMs={processDurationMs}/>
    if (entry.kind === 'usage') return <HistoryUsageEvent key={entry.id} entry={entry}/>
    if (entry.kind === 'lifecycle') return <HistoryLifecycleEvent key={entry.id} entry={entry} showAllEvents={showAllEvents}/>
    return null
  })}</>
}

export function PiLiveHistoryTaskRound({
  projection,
  showAllEvents = false,
  beforeContent,
  summaryMeta,
}: {
  projection: PiLiveTaskRoundProjection
  showAllEvents?: boolean
  beforeContent?: ReactNode
  summaryMeta?: ReactNode
}) {
  return <TaskRound model={projection.model} className="pi-live-history-round" summaryMeta={summaryMeta}>
    {beforeContent}
    <HistoryEntries items={projection.items} showAllEvents={showAllEvents} processState={projection.model.state} processDurationMs={projection.model.durationMs}/>
  </TaskRound>
}


export interface PiLiveIndexedProcessLoadResult {
  items: PiLiveHistoryItem[]
  partial: boolean
}

export function PiLiveIndexedTaskRound({
  item,
  showAllEvents = false,
  loadProcess,
  expansionStore,
}: {
  item: LiveHistoryIndexItemDto
  showAllEvents?: boolean
  loadProcess(cursor: string, revision: string, signal?: AbortSignal): Promise<PiLiveIndexedProcessLoadResult>
  expansionStore?: Map<string, boolean>
}) {
  const { t, i18n } = useTranslation('piLive')
  const summary = item.summary
  const process = summary?.process
  const [loadedItems, setLoadedItems] = useState<PiLiveHistoryItem[]>([])
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [loadError, setLoadError] = useState('')
  const [partial, setPartial] = useState(process?.availability === 'partial')
  const abortRef = useRef<AbortController | null>(null)
  const processId = `process:pi-index-round-${item.ordinal}`

  const startProcessLoad = useCallback((revision: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoadState('loading')
    setLoadError('')
    void loadProcess(item.cursor, revision, controller.signal).then(
      result => {
        if (controller.signal.aborted) return
        if (abortRef.current === controller) abortRef.current = null
        setLoadedItems(result.items)
        setPartial(current => current || result.partial)
        setLoadState('loaded')
      },
      error => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
        if (abortRef.current === controller) abortRef.current = null
        setLoadState('error')
        setLoadError(error instanceof Error ? error.message : String(error))
      },
    )
  }, [item.cursor, loadProcess])

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setLoadedItems([])
    setLoadError('')
    setPartial(process?.availability === 'partial')
    if (process && process.itemCount > 0 && expansionStore?.get(processId) === true) {
      startProcessLoad(process.revision)
    } else {
      setLoadState('idle')
    }
    return () => abortRef.current?.abort()
  }, [expansionStore, item.cursor, process?.availability, process?.itemCount, process?.revision, processId, startProcessLoad])

  const processEntry = useMemo(() => {
    if (!loadedItems.length) return undefined
    const entries = historyEntries(projectPiLiveTurnItems(loadedItems))
    return entries.find((entry): entry is Extract<HistoryRenderEntry, { kind: 'process' }> => entry.kind === 'process')
  }, [loadedItems])

  const requestProcess = useCallback(() => {
    if (!process || process.itemCount <= 0 || loadState === 'loading' || loadState === 'loaded') return
    startProcessLoad(process.revision)
  }, [loadState, process, startProcessLoad])

  const cancelProcess = () => {
    if (loadState !== 'loading') return
    abortRef.current?.abort()
    abortRef.current = null
    setLoadState('idle')
  }

  const model: TaskRoundModel = {
    id: `pi-index-round-${item.ordinal}`,
    semanticId: `pi-round-${item.ordinal}`,
    ordinal: item.ordinal,
    label: t('projection.round', { count: item.ordinal }),
    state: 'settled',
    preview: item.preview,
    toolCount: process?.toolCount ?? 0,
    errorCount: process?.errorCount ?? 0,
    durationMs: 0,
    highLatency: false,
  }

  const terminal = summary?.terminal
  const beforeFinalEvents = summary?.events?.filter(event => event.phase === 'before-final') ?? []
  const afterFinalEvents = summary?.events?.filter(event => event.phase === 'after-final') ?? []
  const renderIndexedEvent = (event: LiveHistoryEventSummaryDto) => <TaskEvent key={event.id} model={{
    id: `pi-index-event:${item.ordinal}:${event.id}`,
    label: event.label,
    category: event.category,
    summary: event.detail,
    time: event.at ? formatClock(event.at, i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN') : undefined,
  }}/>
  const terminalLabel = terminal?.status === 'error'
    ? t('history.terminalError')
    : terminal?.status === 'aborted'
      ? t('history.terminalAborted')
      : terminal?.status === 'stopped'
        ? t('history.terminalStopped')
        : t('history.terminalCompleted')

  return <TaskRound model={model} className="pi-live-history-round">
    {(summary?.promptText || item.preview) && <TaskMessage
      role="user"
      text={summary?.promptText || item.preview || ''}
      author={t('history.user')}
      className="pi-live-task-message"
    />}
    {process && process.itemCount > 0 && <TaskProcessGroup
      id={processId}
      messageCount={process.messageCount}
      toolCount={process.toolCount}
      errorCount={process.errorCount}
      durationMs={process.durationMs}
      thinkingDurationMs={loadState === 'loaded' && processEntry ? measuredThinkingDuration(processEntry.items) : undefined}
      state="settled"
      defaultExpanded={false}
      expansionStore={expansionStore}
      onExpandedChange={expanded => expanded ? requestProcess() : cancelProcess()}
      summaryExtra={partial ? <span>{t('history.partialProcess')}</span> : undefined}
    >
      {loadState === 'idle' && <div className="task-process-loading">{t('history.expandToLoad')}</div>}
      {loadState === 'loading' && <div className="task-process-loading">{t('history.loadingProcess')}</div>}
      {loadState === 'error' && <div className="task-process-load-error" role="alert">
        <span>{loadError || t('history.processLoadFailed')}</span>
        <button type="button" onClick={requestProcess}>{t('history.retry')}</button>
      </div>}
      {loadState === 'loaded' && processEntry && <div className="task-process-sequence">
        <HistoryProcessSequence
          id={processId}
          items={processEntry.items}
          settled
          showAllEvents={showAllEvents}
          expansionStore={expansionStore}
        />
      </div>}
    </TaskProcessGroup>}
    {beforeFinalEvents.map(renderIndexedEvent)}
    {summary?.finalText && <TaskMessage
      role="assistant"
      text={summary.finalText}
      author="Pi"
      modelLabel={summary.modelLabel}
      className="pi-live-task-message"
    />}
    {afterFinalEvents.map(renderIndexedEvent)}
    {summary?.eventOmittedCount ? <TaskEvent model={{
      id: `pi-index-event-omitted:${item.ordinal}`,
      label: t('history.moreEvents', { count: summary.eventOmittedCount }),
      category: 'unknown',
    }}/> : null}
    {terminal && <TaskEvent model={{
      id: `terminal:pi-index-round-${item.ordinal}`,
      label: terminalLabel,
      category: 'lifecycle',
      summary: terminal.detail || undefined,
    }}/>}
  </TaskRound>
}

export function PiLiveCurrentTaskRound({
  model,
  promptText,
  items,
  showAllEvents = false,
  pendingMessageCount,
  assistantModelLabel,
}: {
  model: TaskRoundModel
  promptText?: string
  items: PiLiveHistoryItem[]
  showAllEvents?: boolean
  pendingMessageCount: number
  assistantModelLabel?: string | undefined
}) {
  const { t } = useTranslation('piLive')
  const presentedItems = projectPiLiveTurnItems(omitPiLivePromptMessages(items, promptText))
  return <TaskRound
    model={model}
    className="pi-live-current-round"
    summaryMeta={pendingMessageCount > 0 ? <span>{t('history.queued', { count: pendingMessageCount })}</span> : undefined}
  >
    {promptText && <TaskMessage role="user" text={promptText} author={t('history.user')} className="pi-live-task-message pi-live-optimistic-message"/>}
    {model.state === 'running' && Boolean(promptText) && !hasPiLiveResponseActivity(items) && <TaskMessage role="assistant" text="" author="Pi" pending className="pi-live-task-message pi-live-response-pending"/>}
    <HistoryEntries items={presentedItems} showAllEvents={showAllEvents} processState={model.state} assistantModelLabel={assistantModelLabel} processDurationMs={model.durationMs}/>
  </TaskRound>
}
