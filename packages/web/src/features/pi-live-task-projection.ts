import type { LiveHistoryIndexItemDto, PiLiveStateDto } from '@agent-lens/protocol'
import type { TaskDetailModel, TaskRoundModel } from './task-detail-model'
import type { PiLiveHistoryItem, PiLiveTurnSection } from './pi-live-history'
import { currentProductLocale, translateProduct } from '../i18n/runtime'
import { taskTurnFinalAssistantIndexes } from './task-turn-presentation'

export const PI_LIVE_HISTORY_ROUND_FACT_LIMIT = 8

export interface PiLiveTaskRoundProjection {
  model: TaskRoundModel
  items: PiLiveHistoryItem[]
  continuation: boolean
}

export interface PiLiveRunningRoundProjectionInput {
  items: PiLiveHistoryItem[]
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
  if (!connected) return translateProduct('piLive:projection.channelDisconnected')
  if (!state) return translateProduct('piLive:projection.connecting')
  if (state.status === 'initializing') return state.initializationMessage || translateProduct('piLive:projection.initializing')
  if (state.status === 'failed') return translateProduct('piLive:projection.failed')
  if (state.status === 'terminating') return translateProduct('piLive:projection.terminating')
  if (state.isCompacting) return translateProduct('piLive:projection.compacting')
  if (state.isStreaming) return translateProduct('piLive:projection.working')
  return translateProduct('piLive:projection.waiting')
}

/** 同一 Pi Runtime 在任务列表、会话切换与页头使用一致的任务标题。 */
export function piLiveSessionTitle(state: Pick<PiLiveStateDto, 'taskSummary' | 'sessionName'> | null | undefined): string {
  return state?.taskSummary?.trim() || state?.sessionName?.trim() || translateProduct('piLive:projection.unnamedTask')
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

function isAssistantTerminal(item: PiLiveHistoryItem): boolean {
  return item.kind === 'lifecycle' && ['assistant.stop', 'assistant.error', 'assistant.cancelled'].includes(item.event)
}

function assistantEntryIdentity(item: PiLiveHistoryItem): string | undefined {
  if (item.assistantEntryId) return item.assistantEntryId
  if (isAssistantTerminal(item)) return item.parentId
  if ((item.kind === 'message' || item.kind === 'thinking' || item.kind === 'tool') && item.contentIndex !== undefined) {
    const persistedMarker = item.id.indexOf(':content:')
    if (persistedMarker > 0) return item.id.slice(0, persistedMarker)
    const liveMatch = /^(pi-live-current:message-\d+):/.exec(item.id)
    if (liveMatch?.[1]) return liveMatch[1]
    return item.id
  }
  return undefined
}

function withTurnSection(item: PiLiveHistoryItem, turnSection: PiLiveTurnSection): PiLiveHistoryItem {
  return { ...item, turnSection }
}

/**
 * 完整语义轮次先统一成 prompt → process(只含模型执行) → meta → final → terminal → artifacts，
 * 然后才允许做 8 条事实的渲染分片。meta 不参与 Final 边界判断。
 */
export function projectPiLiveTurnItems(items: PiLiveHistoryItem[]): PiLiveHistoryItem[] {
  const assistantEntriesWithTools = new Set(items
    .filter((item): item is Extract<PiLiveHistoryItem, { kind: 'tool' }> => item.kind === 'tool')
    .map(assistantEntryIdentity)
    .filter((value): value is string => Boolean(value)))

  const finalAssistantIndexes = taskTurnFinalAssistantIndexes(items, item => {
    if (item.kind === 'message' && item.role === 'user') return 'prompt'
    if (item.kind === 'message' && item.role === 'assistant') {
      const identity = assistantEntryIdentity(item)
      return identity && assistantEntriesWithTools.has(identity) ? 'process' : 'assistant'
    }
    if (item.kind === 'thinking' || item.kind === 'tool') return 'process'
    if (item.kind === 'lifecycle' && item.event === 'artifact.action') return 'artifact'
    if (isAssistantTerminal(item)) return 'meta'
    if (item.kind === 'usage' || item.kind === 'lifecycle') return 'meta'
    return 'meta'
  })

  const finalAssistantEntryIds = new Set([...finalAssistantIndexes]
    .map(index => {
      const item = items[index]
      return item ? assistantEntryIdentity(item) : undefined
    })
    .filter((value): value is string => Boolean(value)))

  const prompt: PiLiveHistoryItem[] = []
  const process: PiLiveHistoryItem[] = []
  const meta: PiLiveHistoryItem[] = []
  const terminal: PiLiveHistoryItem[] = []
  const final: PiLiveHistoryItem[] = []
  const artifacts: PiLiveHistoryItem[] = []

  for (const [index, item] of items.entries()) {
    if (item.kind === 'message' && item.role === 'user') {
      prompt.push(withTurnSection(item, 'prompt'))
      continue
    }
    if (finalAssistantIndexes.has(index)) {
      final.push(withTurnSection(item, 'final'))
      continue
    }
    const identity = assistantEntryIdentity(item)
    if (isAssistantTerminal(item) && identity && finalAssistantEntryIds.has(identity)) {
      terminal.push(withTurnSection(item, 'terminal'))
      continue
    }
    if (item.kind === 'lifecycle' && item.event === 'artifact.action') {
      artifacts.push(withTurnSection(item, 'artifact'))
      continue
    }
    if (item.kind === 'usage' || item.kind === 'lifecycle') {
      meta.push(withTurnSection(item, 'meta'))
      continue
    }
    process.push(withTurnSection(item, 'process'))
  }

  return [...prompt, ...process, ...meta, ...final, ...terminal, ...artifacts]
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
    return total + 56
  }, 0)
  return 34 + factHeight
}

export function projectPiLiveTaskRounds(history: PiLiveHistoryItem[]): PiLiveTaskRoundProjection[] {
  const result: PiLiveTaskRoundProjection[] = []

  for (const round of semanticRounds(history)) {
    const presentedItems = projectPiLiveTurnItems(round.items)
    const toolCount = presentedItems.filter(item => item.kind === 'tool').length
    const errorCount = presentedItems.filter(item => item.kind === 'tool' && item.status === 'error').length
    const durationMs = roundDuration(round.items)
    const preview = roundPreview(round.items)
    const fragments = Math.max(1, Math.ceil(presentedItems.length / PI_LIVE_HISTORY_ROUND_FACT_LIMIT))
    const semanticId = round.background ? 'pi-background' : `pi-round-${round.ordinal}`

    for (let index = 0; index < fragments; index += 1) {
      const items = presentedItems.slice(index * PI_LIVE_HISTORY_ROUND_FACT_LIMIT, (index + 1) * PI_LIVE_HISTORY_ROUND_FACT_LIMIT)
      const continuation = index > 0
      const baseLabel = round.background ? translateProduct('piLive:projection.background') : translateProduct('piLive:projection.round', { count: round.ordinal })
      result.push({
        model: {
          id: `${round.background ? 'background' : `round-${round.ordinal}`}:${index}`,
          semanticId,
          ordinal: round.background ? undefined : round.ordinal,
          label: continuation ? translateProduct('piLive:projection.continuation', { label: baseLabel }) : baseLabel,
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

export function projectPiLiveHistoryIndexRound(item: LiveHistoryIndexItemDto): TaskRoundModel {
  return {
    id: `pi-index-round-${item.ordinal}`,
    semanticId: `pi-round-${item.ordinal}`,
    ordinal: item.ordinal,
    label: translateProduct('piLive:projection.round', { count: item.ordinal }),
    state: 'settled',
    preview: item.preview,
    toolCount: item.summary?.process.toolCount ?? 0,
    errorCount: item.summary?.process.errorCount ?? 0,
    durationMs: 0,
    highLatency: false,
  }
}

export function projectPiLiveRunningRound(input: PiLiveRunningRoundProjectionInput): TaskRoundModel {
  const tools = input.items.filter((item): item is Extract<PiLiveHistoryItem, { kind: 'tool' }> => item.kind === 'tool')
  return {
    id: 'pi-live-current-round',
    semanticId: 'pi-live-current-round',
    label: translateProduct('piLive:projection.currentRound'),
    state: input.isStreaming ? 'running' : 'stopped',
    toolCount: tools.length,
    errorCount: tools.filter(tool => tool.status === 'error').length,
    durationMs: 0,
    highLatency: false,
  }
}

export function projectPiLiveTaskDetail(input: {
  state: PiLiveStateDto | null
  connected: boolean
  historyRounds: PiLiveTaskRoundProjection[]
  historyRoundModels?: TaskRoundModel[] | undefined
  runningRound?: TaskRoundModel | undefined
}): TaskDetailModel {
  const state = input.state
  const usageItems = input.historyRounds.flatMap(round => round.items).filter((item): item is Extract<PiLiveHistoryItem, { kind: 'usage' }> => item.kind === 'usage')
  const totalTokens = usageItems.reduce((sum, item) => sum + item.usage.totalTokens, 0)
  const totalCost = usageItems.reduce((sum, item) => sum + (item.usage.cost?.total ?? 0), 0)
  return {
    id: state?.runtimeSessionId ?? 'pi-live-pending',
    title: piLiveSessionTitle(state),
    agentLabel: 'Pi',
    contextLabel: runtimeModelLabel(state),
    projectLabel: state?.projectName,
    workspacePath: state?.workspacePath,
    statusLabel: runtimeStatusLabel(state, input.connected),
    metrics: [
      ...(totalTokens > 0 ? [{ value: totalTokens.toLocaleString(currentProductLocale()), label: translateProduct('piLive:projection.tokens') }] : []),
      ...(totalCost > 0 ? [{ value: `${totalCost.toFixed(4)}`, label: translateProduct('piLive:projection.cost') }] : []),
      { value: state?.pendingMessageCount ?? 0, label: translateProduct('piLive:projection.queued'), tone: state?.pendingMessageCount ? 'accent' : undefined },
      { value: state?.processId ?? '—', label: 'PID' },
    ],
    rounds: [
      ...(input.historyRoundModels ?? input.historyRounds.map(round => round.model)),
      ...(input.runningRound ? [input.runningRound] : []),
    ],
  }
}
