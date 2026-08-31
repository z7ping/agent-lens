import { useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { toolVisualKind, toolVisualLabel } from '../components/ToolKindIcon'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
import { TaskThinking } from './TaskThinking'
import { TaskToolGroup } from './TaskToolGroup'
import type { TaskRoundModel, TaskThinkingModel, TaskToolGroupModel, TaskToolKind, TaskToolModel } from './task-detail-model'
import type { PiLiveHistoryItem } from './pi-live-history'
import type { PiLiveTaskRoundProjection } from './pi-live-task-projection'

export interface PiLiveRunningTool {
  id: string
  name: string
  status: 'running' | 'success' | 'error'
  summary: string
  output: string
}

interface ToolTiming {
  startedAtMs: number
  durationMs?: number | undefined
}

function formatClock(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function compactPreview(value: string, max = 120): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function toolKindLabel(kind: TaskToolKind): string {
  if (kind === 'shell') return 'Shell'
  if (kind === 'read') return '读取'
  if (kind === 'edit') return '修改'
  if (kind === 'search') return '搜索'
  if (kind === 'mcp') return 'MCP'
  if (kind === 'web') return '网络'
  return '工具'
}

function taskTool(
  name: string,
  id: string,
  status: TaskToolModel['status'],
  summary: string,
  output: string,
  timing?: { durationMs?: number | undefined; startedAtMs?: number | undefined },
): TaskToolModel {
  const visualKind = toolVisualKind(name)
  const kind: TaskToolKind = visualKind === 'test' ? 'tool' : visualKind
  return {
    id,
    name,
    kind,
    kindLabel: toolVisualLabel(visualKind),
    status,
    primary: summary || undefined,
    output: output || undefined,
    durationMs: timing?.durationMs,
    startedAtMs: timing?.startedAtMs,
  }
}

function toolGroup(id: string, tools: TaskToolModel[]): TaskToolGroupModel {
  const counts = new Map<TaskToolKind, number>()
  for (const tool of tools) counts.set(tool.kind, (counts.get(tool.kind) ?? 0) + 1)
  return {
    id,
    label: '工具执行',
    itemCount: tools.length,
    errorCount: tools.filter(tool => tool.status === 'error').length,
    kindCounts: [...counts.entries()].map(([kind, count]) => ({ kind, label: toolKindLabel(kind), count })),
    tools,
  }
}

function ToolOutput({ tool }: { tool: TaskToolModel }) {
  if (!tool.output) return null
  if (tool.status === 'running') {
    return <div className="tool-live-output" role="status" aria-label={`${tool.name} 实时输出`}><pre>{tool.output}</pre></div>
  }
  return <details className="tool-output-details" open={tool.status === 'error'}>
    <summary>{tool.status === 'error' ? '错误 / 输出' : '查看输出'}</summary>
    <pre>{tool.output}</pre>
  </details>
}

type HistoryTool = Extract<PiLiveHistoryItem, { kind: 'tool' }>
type HistoryRenderEntry = PiLiveHistoryItem | { kind: 'tool-group'; id: string; items: HistoryTool[] }

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

function HistoryThinking({ item }: { item: Extract<PiLiveHistoryItem, { kind: 'thinking' }> }) {
  const model: TaskThinkingModel = {
    id: item.id,
    label: '思考',
    text: item.text,
    preview: compactPreview(item.text),
    time: item.at ? formatClock(item.at) : undefined,
    state: 'settled',
  }
  return <TaskThinking model={model} defaultExpanded><div>{item.text}</div></TaskThinking>
}

function HistoryToolGroup({ id, items }: { id: string; items: HistoryTool[] }) {
  const model = toolGroup(id, items.map(item => taskTool(
    item.name,
    item.id,
    item.status,
    item.summary,
    item.output,
    { durationMs: item.durationMs },
  )))
  return <TaskToolGroup
    model={model}
    renderDetails={tool => <ToolOutput tool={tool}/>}
  />
}

export function PiLiveHistoryTaskRound({ projection }: { projection: PiLiveTaskRoundProjection }) {
  const entries = historyEntries(projection.items)
  return <TaskRound model={projection.model} className="pi-live-history-round">
    {entries.map(entry => {
      if (entry.kind === 'message') {
        return <TaskMessage
          key={entry.id}
          role={entry.role}
          text={entry.text}
          author={entry.role === 'user' ? '你' : 'Pi'}
          time={entry.at ? formatClock(entry.at) : undefined}
          className="pi-live-task-message"
        />
      }
      if (entry.kind === 'thinking') return <HistoryThinking key={entry.id} item={entry}/>
      if (entry.kind === 'tool-group') return <HistoryToolGroup key={entry.id} id={entry.id} items={entry.items}/>
      if (entry.kind === 'lifecycle') {
        return <div key={entry.id} className="pi-live-history-lifecycle">
          <b>{entry.label}</b>
          {entry.detail && <span>{entry.detail}</span>}
          {entry.at && <time>{formatClock(entry.at)}</time>}
        </div>
      }
      return null
    })}
  </TaskRound>
}

export function PiLiveRunningTaskRound({
  model,
  thinkingText,
  tools,
  streamText,
  isStreaming,
  pendingMessageCount,
}: {
  model: TaskRoundModel
  thinkingText: string
  tools: PiLiveRunningTool[]
  streamText: string
  isStreaming: boolean
  pendingMessageCount: number
}) {
  const timingRef = useRef(new Map<string, ToolTiming>())
  const now = Date.now()
  const currentIds = new Set(tools.map(tool => tool.id))
  for (const id of timingRef.current.keys()) {
    if (!currentIds.has(id)) timingRef.current.delete(id)
  }
  const toolModels = tools.map(tool => {
    let timing = timingRef.current.get(tool.id)
    if (!timing) {
      timing = { startedAtMs: now }
      timingRef.current.set(tool.id, timing)
    }
    if (tool.status !== 'running' && timing.durationMs === undefined) timing.durationMs = Math.max(0, now - timing.startedAtMs)
    return taskTool(tool.name, tool.id, tool.status, tool.summary, tool.output, timing)
  })
  const thinking: TaskThinkingModel = {
    id: 'pi-live-current-thinking',
    label: '思考',
    text: thinkingText,
    preview: compactPreview(thinkingText),
    state: model.state,
  }

  return <TaskRound
    model={model}
    className="pi-live-current-round"
    summaryMeta={pendingMessageCount > 0 ? <span>{pendingMessageCount} 条排队</span> : undefined}
  >
    {thinkingText && <TaskThinking model={thinking} defaultExpanded><div>{thinkingText}</div></TaskThinking>}
    {toolModels.length > 0 && <TaskToolGroup
      model={toolGroup('pi-live-current-tools', toolModels)}
      renderDetails={tool => <ToolOutput tool={tool}/>}
    />}
    {streamText && <div className="pi-live-stream-response">
      <div className="pi-live-message-meta"><b>Pi</b><span>{isStreaming ? '生成中' : '输出'}</span></div>
      <div className="markdown"><ReactMarkdown>{streamText}</ReactMarkdown></div>
      {isStreaming && <span className="pi-live-caret" aria-hidden="true"/>}
    </div>}
  </TaskRound>
}
