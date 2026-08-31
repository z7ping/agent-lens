import ReactMarkdown from 'react-markdown'
import { toolVisualKind } from '../components/ToolKindIcon'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
import { TaskThinking } from './TaskThinking'
import { TaskToolGroup } from './TaskToolGroup'
import type { TaskThinkingModel, TaskToolGroupModel, TaskToolKind, TaskToolModel } from './task-detail-model'
import type { PiLiveHistoryItem } from './pi-live-history'
import type { PiLiveTaskRoundProjection } from './pi-live-task-projection'

export interface PiLiveRunningTool {
  id: string
  name: string
  status: 'running' | 'success' | 'error'
  summary: string
  output: string
}

function formatClock(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function toolKindLabel(kind: TaskToolKind): string {
  if (kind === 'shell') return '命令'
  if (kind === 'read') return '读取'
  if (kind === 'edit') return '修改'
  if (kind === 'search') return '搜索'
  if (kind === 'mcp') return 'MCP（模型上下文协议）'
  if (kind === 'web') return '网络'
  return '工具'
}

function taskTool(name: string, id: string, status: TaskToolModel['status'], summary: string, output: string, time?: string): TaskToolModel {
  const kind = toolVisualKind(name)
  return {
    id,
    name,
    kind,
    kindLabel: toolKindLabel(kind),
    status,
    primary: summary || undefined,
    output: output || undefined,
    durationLabel: time || undefined,
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
    label: '可观察过程片段',
    text: item.text,
    time: item.at ? formatClock(item.at) : undefined,
    state: 'settled',
  }
  return <TaskThinking model={model}><div>{item.text}</div></TaskThinking>
}

function HistoryToolGroup({ id, items }: { id: string; items: HistoryTool[] }) {
  const model = toolGroup(id, items.map(item => taskTool(
    item.name,
    item.id,
    item.status,
    item.summary,
    item.output,
    item.at ? formatClock(item.at) : undefined,
  )))
  return <TaskToolGroup
    model={model}
    renderDetails={tool => tool.output ? <details><summary>查看输出</summary><pre>{tool.output}</pre></details> : null}
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
  thinkingText,
  tools,
  streamText,
  isStreaming,
  pendingMessageCount,
}: {
  thinkingText: string
  tools: PiLiveRunningTool[]
  streamText: string
  isStreaming: boolean
  pendingMessageCount: number
}) {
  const toolModels = tools.map(tool => taskTool(tool.name, tool.id, tool.status, tool.summary, tool.output))
  const round = {
    id: 'pi-live-current-round',
    label: '当前轮次',
    state: isStreaming ? 'running' as const : 'stopped' as const,
    toolCount: tools.length,
    errorCount: tools.filter(tool => tool.status === 'error').length,
    durationMs: 0,
    highLatency: false,
  }
  const thinking: TaskThinkingModel = {
    id: 'pi-live-current-thinking',
    label: '可观察过程片段',
    text: thinkingText,
    state: isStreaming ? 'running' : 'stopped',
  }

  return <TaskRound
    model={round}
    className="pi-live-current-round"
    summaryMeta={pendingMessageCount > 0 ? <span>{pendingMessageCount} 条排队</span> : undefined}
  >
    {thinkingText && <TaskThinking model={thinking}><div>{thinkingText}</div></TaskThinking>}
    {toolModels.length > 0 && <TaskToolGroup
      model={toolGroup('pi-live-current-tools', toolModels)}
      defaultExpanded
      renderDetails={tool => tool.output ? <details><summary>查看输出</summary><pre>{tool.output}</pre></details> : null}
    />}
    {streamText && <div className="pi-live-stream-response">
      <div className="pi-live-message-meta"><b>Pi</b><span>{isStreaming ? '生成中' : '输出'}</span></div>
      <div className="markdown"><ReactMarkdown>{streamText}</ReactMarkdown></div>
      {isStreaming && <span className="pi-live-caret" aria-hidden="true"/>}
    </div>}
  </TaskRound>
}
