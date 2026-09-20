import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { LiveHistoryIndexItemDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { MarkdownContent } from '../components/MarkdownContent'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { toolVisualKind } from '../components/ToolKindIcon'
import { UiIcon } from '../components/UiIcon'
import { TaskEvent } from './TaskEvent'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
import { TaskProcessGroup } from './TaskProcessGroup'
import { TaskToolGroup } from './TaskToolGroup'
import type { TaskRoundModel, TaskToolGroupModel, TaskToolKind, TaskToolModel } from './task-detail-model'
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
  timing: { durationMs?: number | undefined; startedAtMs?: number | undefined } | undefined,
  t: TFunction,
): TaskToolModel {
  const visualKind = toolVisualKind(name)
  const kind: TaskToolKind = visualKind === 'test' ? 'tool' : visualKind
  return {
    id,
    name,
    kind,
    kindLabel: t(`task:tool.kind.${kind}`),
    status,
    primary: summary || undefined,
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

function ToolOutput({ tool }: { tool: TaskToolModel }) {
  const { t } = useTranslation('piLive')
  if (!tool.output) return null
  if (tool.status === 'running') {
    return <div className="task-tool-live-output" role="status" aria-label={t('history.liveOutput', { tool: tool.name })}><CopyableCodeBlock copyValue={tool.output}>{tool.output}</CopyableCodeBlock></div>
  }
  return <details className="task-tool-output-details" open={tool.status === 'error'}>
    <summary><UiIcon className="task-tool-output-chevron" name="chevron-right" size={14}/><span>{tool.status === 'error' ? t('history.errorOutput') : t('history.viewOutput')}</span></summary>
    <CopyableCodeBlock copyValue={tool.output}>{tool.output}</CopyableCodeBlock>
  </details>
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

function HistoryToolGroup({ id, items, settled = false }: { id: string; items: HistoryTool[]; settled?: boolean }) {
  const { t } = useTranslation(['piLive', 'task'])
  const model = toolGroup(id, items.map(item => taskTool(
    item.name,
    item.id,
    settled && item.status === 'running' ? 'unknown' : item.status,
    item.summary,
    item.output,
    { durationMs: item.durationMs, startedAtMs: item.startedAtMs },
    t,
  )), t)
  return <TaskToolGroup model={model} renderDetails={tool => <ToolOutput tool={tool}/>}/>
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

function HistoryLifecycleEvent({ entry, showAllEvents }: { entry: Extract<PiLiveHistoryItem, { kind: 'lifecycle' }>; showAllEvents: boolean }) {
  const { i18n } = useTranslation('piLive')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  if (entry.event === 'native.unknown' && !showAllEvents) return null
  const summary = piLiveLifecycleSummary(entry)
  return <TaskEvent model={{
    id: entry.id,
    label: entry.label,
    category: entry.event === 'artifact.action' ? 'artifact' : entry.event === 'native.unknown' ? 'unknown' : 'lifecycle',
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

function HistoryProcessGroup({
  id,
  items,
  state,
  showAllEvents,
}: {
  id: string
  items: HistoryProcessItem[]
  state: TaskRoundModel['state']
  showAllEvents: boolean
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
    startedAtMs={timing.startedAtMs}
    endedAtMs={state === 'running' ? undefined : timing.endedAtMs}
    state={state}
  >
    <div className="task-process-sequence">
      {items.map(item => {
        if (item.kind === 'tool-group') return <HistoryToolGroup key={item.id} id={item.id} items={item.items} settled={state !== 'running'}/>
        if (item.kind === 'thinking') return <div className="task-process-message" data-message-role="reasoning" key={item.id}>
          <div className="task-process-message-kind">{t('history.thinking')}</div>
          <ThinkingMarkdown text={item.text} streaming={state === 'running' && item.state === 'running'}/>
        </div>
        if (item.kind === 'message') return <div className="task-process-message" data-message-role="commentary" key={item.id}>
          <div className="task-process-message-kind">{t('history.commentary')}</div>
          <ThinkingMarkdown text={item.text} streaming={state === 'running' && item.state === 'running'}/>
        </div>
        if (item.kind === 'usage') return <HistoryUsageEvent key={item.id} entry={item}/>
        if (item.kind === 'lifecycle') return <HistoryLifecycleEvent key={item.id} entry={item} showAllEvents={showAllEvents}/>
        return null
      })}
    </div>
  </TaskProcessGroup>
}

function HistoryEntries({
  items,
  showAllEvents = false,
  processState = 'settled',
  assistantModelLabel,
}: {
  items: PiLiveHistoryItem[]
  showAllEvents?: boolean
  processState?: TaskRoundModel['state']
  assistantModelLabel?: string | undefined
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
    if (entry.kind === 'process') return <HistoryProcessGroup key={entry.id} id={entry.id} items={entry.items} state={resolvedProcessState} showAllEvents={showAllEvents}/>
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
    <HistoryEntries items={projection.items} showAllEvents={showAllEvents} processState={projection.model.state}/>
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
  const renderIndexedEvent = (event: NonNullable<typeof summary>['events'][number]) => <TaskEvent key={event.id} model={{
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
        {processEntry.items.map(processItem => {
          if (processItem.kind === 'tool-group') return <HistoryToolGroup key={processItem.id} id={processItem.id} items={processItem.items}/>
          if (processItem.kind === 'thinking') return <div className="task-process-message" data-message-role="reasoning" key={processItem.id}>
            <div className="task-process-message-kind">{t('history.thinking')}</div>
            <ThinkingMarkdown text={processItem.text}/>
          </div>
          if (processItem.kind === 'message') return <div className="task-process-message" data-message-role="commentary" key={processItem.id}>
            <div className="task-process-message-kind">{t('history.commentary')}</div>
            <ThinkingMarkdown text={processItem.text}/>
          </div>
          if (processItem.kind === 'usage') return <HistoryUsageEvent key={processItem.id} entry={processItem}/>
          if (processItem.kind === 'lifecycle') return <HistoryLifecycleEvent key={processItem.id} entry={processItem} showAllEvents={showAllEvents}/>
          return null
        })}
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
    <HistoryEntries items={presentedItems} showAllEvents={showAllEvents} processState={model.state} assistantModelLabel={assistantModelLabel}/>
  </TaskRound>
}
