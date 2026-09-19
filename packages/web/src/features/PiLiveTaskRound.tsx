import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
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
import type { PiLiveTaskRoundProjection } from './pi-live-task-projection'

function formatClock(value: string, locale: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
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
type HistoryProcessItem = Extract<PiLiveHistoryItem, { kind: 'thinking' }> | HistoryToolGroup
type HistoryRenderEntry = PiLiveHistoryItem | HistoryToolGroup | { kind: 'process'; id: string; items: HistoryProcessItem[] }

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
  const flat: Array<PiLiveHistoryItem | HistoryToolGroup> = []
  let tools: HistoryTool[] = []
  const flushTools = () => {
    if (!tools.length) return
    flat.push({ kind: 'tool-group', id: `tools:${tools.map(tool => tool.id).join(':')}`, items: tools })
    tools = []
  }
  for (const item of items) {
    if (item.kind === 'tool') {
      tools.push(item)
      continue
    }
    flushTools()
    flat.push(item)
  }
  flushTools()

  const result: HistoryRenderEntry[] = []
  const processItems: HistoryProcessItem[] = []
  let processIndex: number | undefined
  for (const entry of flat) {
    if (entry.kind === 'thinking' || entry.kind === 'tool-group') {
      processIndex ??= result.length
      processItems.push(entry)
      continue
    }
    result.push(entry)
  }
  if (processItems.length) {
    const first = processItems[0]!
    result.splice(processIndex ?? 0, 0, { kind: 'process', id: `process:${first.id}`, items: processItems })
  }
  return result
}

function ThinkingMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <MarkdownContent text={text} streaming={streaming}/>
}

function HistoryToolGroup({ id, items }: { id: string; items: HistoryTool[] }) {
  const { t } = useTranslation(['piLive', 'task'])
  const model = toolGroup(id, items.map(item => taskTool(
    item.name,
    item.id,
    item.status,
    item.summary,
    item.output,
    { durationMs: item.durationMs, startedAtMs: item.startedAtMs },
    t,
  )), t)
  return <TaskToolGroup
    model={model}
    renderDetails={tool => <ToolOutput tool={tool}/>}
  />
}

function HistoryProcessGroup({
  id,
  items,
  state,
  durationMs,
}: {
  id: string
  items: HistoryProcessItem[]
  state: TaskRoundModel['state']
  durationMs: number
}) {
  const { t } = useTranslation('piLive')
  const thinking = items.filter((item): item is Extract<PiLiveHistoryItem, { kind: 'thinking' }> => item.kind === 'thinking')
  const tools = items.flatMap(item => item.kind === 'tool-group' ? item.items : [])
  return <TaskProcessGroup
    id={id}
    messageCount={thinking.length}
    toolCount={tools.length}
    errorCount={tools.filter(tool => tool.status === 'error').length}
    durationMs={durationMs}
    state={state}
  >
    <div className="task-process-sequence">
      {items.map(item => item.kind === 'tool-group'
        ? <HistoryToolGroup key={item.id} id={item.id} items={item.items}/>
        : <div className="task-process-message" data-message-role="reasoning" key={item.id}>
            <div className="task-process-message-kind">{t('history.thinking')}</div>
            <ThinkingMarkdown text={item.text} streaming={item.state === 'running'}/>
          </div>)}
    </div>
  </TaskProcessGroup>
}

function HistoryEntries({
  items,
  showAllEvents = false,
  processState = 'settled',
  processDurationMs = 0,
  assistantModelLabel,
}: {
  items: PiLiveHistoryItem[]
  showAllEvents?: boolean
  processState?: TaskRoundModel['state']
  processDurationMs?: number
  assistantModelLabel?: string | undefined
}) {
  const { t, i18n } = useTranslation(['piLive', 'task'])
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const entries = historyEntries(items)
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
    if (entry.kind === 'process') return <HistoryProcessGroup key={entry.id} id={entry.id} items={entry.items} state={processState} durationMs={processDurationMs}/>
    if (entry.kind === 'usage') {
      const cost = entry.usage.cost?.total
      const summary = t('piLive:history.usageSummary', {
        input: entry.usage.inputTokens.toLocaleString(locale),
        output: entry.usage.outputTokens.toLocaleString(locale),
        cacheRead: entry.usage.cacheReadTokens.toLocaleString(locale),
        cacheWrite: entry.usage.cacheWriteTokens.toLocaleString(locale),
        total: entry.usage.totalTokens.toLocaleString(locale),
        cost: cost !== undefined ? ` · ${cost.toFixed(4)}` : '',
      })
      return <TaskEvent key={entry.id} model={{ id: entry.id, label: t('piLive:history.usage'), category: 'usage', summary, time: entry.at ? formatClock(entry.at, locale) : undefined, nativeType: entry.nativeType, parentId: entry.parentId }} raw={entry.raw}/>
    }
    if (entry.kind === 'lifecycle') {
      if (entry.event === 'native.unknown' && !showAllEvents) return null
      const summary = piLiveLifecycleSummary(entry)
      return <TaskEvent key={entry.id} model={{ id: entry.id, label: entry.label, category: entry.event === 'native.unknown' ? 'unknown' : 'lifecycle', summary: summary || undefined, time: entry.at ? formatClock(entry.at, locale) : undefined, nativeType: entry.nativeType, parentId: entry.parentId }} raw={entry.raw}/>
    }
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
  return <TaskRound
    model={model}
    className="pi-live-current-round"
    summaryMeta={pendingMessageCount > 0 ? <span>{t('history.queued', { count: pendingMessageCount })}</span> : undefined}
  >
    {promptText && <TaskMessage role="user" text={promptText} author={t('history.user')} className="pi-live-task-message pi-live-optimistic-message"/>}
    {model.state === 'running' && Boolean(promptText) && !hasPiLiveResponseActivity(items) && <TaskMessage
      role="assistant"
      text=""
      author="Pi"
      pending
      className="pi-live-task-message pi-live-response-pending"
    />}
    <HistoryEntries
      items={omitPiLivePromptMessages(items, promptText)}
      showAllEvents={showAllEvents}
      processState={model.state}
      processDurationMs={model.durationMs}
      assistantModelLabel={assistantModelLabel}
    />
  </TaskRound>
}
