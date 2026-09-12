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
import { TaskThinking } from './TaskThinking'
import { TaskToolGroup } from './TaskToolGroup'
import type { TaskRoundModel, TaskThinkingModel, TaskToolGroupModel, TaskToolKind, TaskToolModel } from './task-detail-model'
import { omitPiLivePromptMessages, type PiLiveHistoryItem } from './pi-live-history'
import type { PiLiveTaskRoundProjection } from './pi-live-task-projection'

function formatClock(value: string, locale: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function compactPreview(value: string, max = 120): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
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
type HistoryRenderEntry = PiLiveHistoryItem | { kind: 'tool-group'; id: string; items: HistoryTool[] }

export function piLiveLifecycleSummary(entry: Extract<PiLiveHistoryItem, { kind: 'lifecycle' }>): string {
  if (entry.event !== 'session.info') return entry.detail
  return entry.detail.replace(/\s*·\s*Pi\s*$/, '').trim()
}

function historyEntries(items: PiLiveHistoryItem[]): HistoryRenderEntry[] {
  const result: HistoryRenderEntry[] = []
  let tools: HistoryTool[] = []
  const flushTools = () => {
    if (!tools.length) return
    result.push({ kind: 'tool-group', id: `tools:${tools.map(tool => tool.id).join(':')}`, items: tools })
    tools = []
  }
  for (const item of items) {
    if (item.kind === 'tool') {
      tools.push(item)
      continue
    }
    flushTools()
    result.push(item)
  }
  flushTools()
  return result
}

function ThinkingMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <MarkdownContent text={text} streaming={streaming}/>
}

function HistoryThinking({ item }: { item: Extract<PiLiveHistoryItem, { kind: 'thinking' }> }) {
  const { t, i18n } = useTranslation('piLive')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const model: TaskThinkingModel = {
    id: item.id,
    label: t('history.thinking'),
    text: item.text,
    preview: compactPreview(item.text),
    time: item.at ? formatClock(item.at, locale) : undefined,
    state: item.state ?? 'settled',
  }
  return <TaskThinking model={model} defaultExpanded><ThinkingMarkdown text={item.text} streaming={item.state === 'running'}/></TaskThinking>
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

function HistoryEntries({ items, showAllEvents = false }: { items: PiLiveHistoryItem[]; showAllEvents?: boolean }) {
  const { t, i18n } = useTranslation(['piLive', 'task'])
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const entries = historyEntries(items)
  return <>{entries.map(entry => {
    if (entry.kind === 'message') {
      return <TaskMessage
        key={entry.id}
        role={entry.role}
        text={entry.text}
        author={entry.role === 'user' ? t('piLive:history.user') : 'Pi'}
        time={entry.at ? formatClock(entry.at, locale) : undefined}
        streaming={entry.role === 'assistant' && entry.state === 'running'}
        className="pi-live-task-message"
      />
    }
    if (entry.kind === 'thinking') return <HistoryThinking key={entry.id} item={entry}/>
    if (entry.kind === 'tool-group') return <HistoryToolGroup key={entry.id} id={entry.id} items={entry.items}/>
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
    <HistoryEntries items={projection.items} showAllEvents={showAllEvents}/>
  </TaskRound>
}

export function PiLiveCurrentTaskRound({
  model,
  promptText,
  items,
  showAllEvents = false,
  pendingMessageCount,
}: {
  model: TaskRoundModel
  promptText?: string
  items: PiLiveHistoryItem[]
  showAllEvents?: boolean
  pendingMessageCount: number
}) {
  const { t } = useTranslation('piLive')
  return <TaskRound
    model={model}
    className="pi-live-current-round"
    summaryMeta={pendingMessageCount > 0 ? <span>{t('history.queued', { count: pendingMessageCount })}</span> : undefined}
  >
    {promptText && <TaskMessage role="user" text={promptText} author={t('history.user')} className="pi-live-task-message pi-live-optimistic-message"/>}
    <HistoryEntries items={omitPiLivePromptMessages(items, promptText)} showAllEvents={showAllEvents}/>
  </TaskRound>
}
