import type { TaskRoundModel } from './task-detail-model'
import type { PiLiveHistoryItem } from './pi-live-history'

export const PI_LIVE_HISTORY_ROUND_FACT_LIMIT = 8

export interface PiLiveTaskRoundProjection {
  model: TaskRoundModel
  items: PiLiveHistoryItem[]
  continuation: boolean
}

interface SemanticRound {
  ordinal: number
  items: PiLiveHistoryItem[]
  background: boolean
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
