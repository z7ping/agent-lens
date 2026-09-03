import type { PiLiveStateDto } from '@agent-lens/protocol'
import type { TaskDetailModel, TaskRoundModel } from './task-detail-model'
import type { PiLiveHistoryItem } from './pi-live-history'

export const PI_LIVE_HISTORY_ROUND_FACT_LIMIT = 8

export interface PiLiveTaskRoundProjection {
  model: TaskRoundModel
  items: PiLiveHistoryItem[]
  continuation: boolean
}

export interface PiLiveRunningToolProjectionInput {
  id: string
  name: string
  status: 'running' | 'success' | 'error'
  summary: string
  output: string
}

export interface PiLiveRunningRoundProjectionInput {
  tools: PiLiveRunningToolProjectionInput[]
  isStreaming: boolean
}

interface SemanticRound {
  ordinal: number
  items: PiLiveHistoryItem[]
  background: boolean
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function runtimeModelLabel(state: PiLiveStateDto | null): string {
  if (!state?.model) return 'Pi'
  const model = record(state.model)
  const provider = stringValue(model.provider)
  const id = stringValue(model.id || model.modelId || model.name)
  return [provider, id].filter(Boolean).join(' / ') || 'Pi'
}

function runtimeStatusLabel(state: PiLiveStateDto | null, connected: boolean): string {
  if (!connected) return '实时通道断开 · 后台服务仍持有任务'
  if (!state) return '正在连接'
  if (state.status === 'initializing') return state.initializationMessage || '正在初始化 Pi Runtime'
  if (state.status === 'failed') return 'Pi Runtime 初始化失败'
  if (state.status === 'terminating') return '正在结束 Pi Runtime'
  if (state.isCompacting) return '正在压缩上下文'
  if (state.isStreaming) return '正在工作'
  return '等待输入'
}

function factTime(item: PiLiveHistoryItem): number | null {
  if (!item.at) return null
  const value = Date.parse(item.at)
  return Number.isFinite(value) ? value : null
}

function roundDuration(items: PiLiveHistoryItem[]): number {
  const times = items.map(factTime).filter((value): value is number => value !== null)
  if (times.length < 2) return 0
  return Math.max(0, Math.max(...times) - Math.min(...times))
}

function roundPreview(items: PiLiveHistoryItem[]): string | undefined {
  const user = items.find(item => item.kind === 'message' && item.role === 'user')
  if (!user || user.kind !== 'message') return undefined
  const text = user.text.replace(/\s+/g, ' ').trim()
  return text.length > 86 ? `${text.slice(0, 86)}…` : text || undefined
}

function semanticRounds(history: PiLiveHistoryItem[]): SemanticRound[] {
  const rounds: SemanticRound[] = []
  let current: SemanticRound | null = null
  let ordinal = 0

  for (const item of history) {
    if (item.kind === 'message' && item.role === 'user') {
      ordinal += 1
      current = { ordinal, items: [item], background: false }
      rounds.push(current)
      continue
    }
    if (!current) {
      current = { ordinal: 0, items: [], background: true }
      rounds.push(current)
    }
    current.items.push(item)
  }
  return rounds.filter(round => round.items.length > 0)
}

export function piLiveTaskRoundEstimate(projection: PiLiveTaskRoundProjection): number {
  const factHeight = projection.items.reduce((total, item) => {
    if (item.kind === 'message') {
      const lines = Math.max(1, Math.ceil(item.text.length / 72))
      return total + Math.min(340, 60 + lines * 23)
    }
    if (item.kind === 'thinking') return total + 52
    if (item.kind === 'tool') return total + (item.output ? 82 : 48)
    // TaskEvent 的主行和折叠原始数据入口都会占高度；与紧凑样式对齐，
    // 避免虚拟轮次从估算高度切到实测高度时产生明显滚动跳动。
    return total + 56
  }, 0)
  return 34 + factHeight
}

export function projectPiLiveTaskRounds(history: PiLiveHistoryItem[]): PiLiveTaskRoundProjection[] {
  const result: PiLiveTaskRoundProjection[] = []

  for (const round of semanticRounds(history)) {
    const toolCount = round.items.filter(item => item.kind === 'tool').length
    const errorCount = round.items.filter(item => item.kind === 'tool' && item.status === 'error').length
    const durationMs = roundDuration(round.items)
    const preview = roundPreview(round.items)
    const fragments = Math.max(1, Math.ceil(round.items.length / PI_LIVE_HISTORY_ROUND_FACT_LIMIT))

    for (let index = 0; index < fragments; index += 1) {
      const items = round.items.slice(index * PI_LIVE_HISTORY_ROUND_FACT_LIMIT, (index + 1) * PI_LIVE_HISTORY_ROUND_FACT_LIMIT)
      const continuation = index > 0
      const baseLabel = round.background ? '后台活动' : `第 ${round.ordinal} 轮`
      result.push({
        model: {
          id: `${round.background ? 'background' : `round-${round.ordinal}`}:${index}`,
          ordinal: round.background ? undefined : round.ordinal,
          label: continuation ? `${baseLabel} · 续` : baseLabel,
          state: 'settled',
          preview: continuation ? undefined : preview,
          toolCount: continuation ? items.filter(item => item.kind === 'tool').length : toolCount,
          errorCount: continuation ? items.filter(item => item.kind === 'tool' && item.status === 'error').length : errorCount,
          durationMs: continuation ? roundDuration(items) : durationMs,
          highLatency: false,
        },
        items,
        continuation,
      })
    }
  }

  return result
}

export function projectPiLiveRunningRound(input: PiLiveRunningRoundProjectionInput): TaskRoundModel {
  return {
    id: 'pi-live-current-round',
    label: '当前轮次',
    state: input.isStreaming ? 'running' : 'stopped',
    toolCount: input.tools.length,
    errorCount: input.tools.filter(tool => tool.status === 'error').length,
    durationMs: 0,
    highLatency: false,
  }
}

export function projectPiLiveTaskDetail(input: {
  state: PiLiveStateDto | null
  connected: boolean
  historyRounds: PiLiveTaskRoundProjection[]
  runningRound?: TaskRoundModel | undefined
}): TaskDetailModel {
  const state = input.state
  const usageItems = input.historyRounds.flatMap(round => round.items).filter((item): item is Extract<PiLiveHistoryItem, { kind: 'usage' }> => item.kind === 'usage')
  const totalTokens = usageItems.reduce((sum, item) => sum + item.usage.totalTokens, 0)
  const totalCost = usageItems.reduce((sum, item) => sum + (item.usage.cost?.total ?? 0), 0)
  return {
    id: state?.runtimeSessionId ?? 'pi-live-pending',
    title: state?.sessionName || 'Pi 实时任务',
    agentLabel: 'Pi',
    contextLabel: runtimeModelLabel(state),
    statusLabel: runtimeStatusLabel(state, input.connected),
    metrics: [
      ...(totalTokens > 0 ? [{ value: totalTokens.toLocaleString(), label: '词元' }] : []),
      ...(totalCost > 0 ? [{ value: `$${totalCost.toFixed(4)}`, label: '成本' }] : []),
      { value: state?.pendingMessageCount ?? 0, label: '排队', tone: state?.pendingMessageCount ? 'accent' : undefined },
      { value: state?.processId ?? '—', label: 'PID' },
    ],
    rounds: [
      ...input.historyRounds.map(round => round.model),
      ...(input.runningRound ? [input.runningRound] : []),
    ],
  }
}
