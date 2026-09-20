import type {
  JsonValue,
  ReviewDetailQueryDto,
  ReviewInteractionDto,
  ReviewNodeDto,
  ReviewProcessSummaryDto,
  ReviewQueryDto,
  ReviewResponseDto,
  ReviewSessionDetailDto,
  ReviewSessionSummaryDto,
} from '@agent-lens/protocol'
import { asRecord, stringField } from './nodes'
import {
  ReviewProjection as BaseReviewProjection,
  reviewProjectionInternals as baseReviewProjectionInternals,
} from './projection'

export { HubReviewProjection, hubReviewProjectionInternals } from './hub'

const MAX_REVIEW_INTERACTION_NODES = 600
const REVIEW_INTERACTION_HEAD_NODES = 240
const REVIEW_INTERACTION_TAIL_NODES = MAX_REVIEW_INTERACTION_NODES - REVIEW_INTERACTION_HEAD_NODES

function normalizeLifecycleAction(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_:\-]+/g, '.')
}

type ReviewTurnSection = 'prompt' | 'process' | 'terminal' | 'final' | 'artifact'

function reviewEventAction(node: Extract<ReviewNodeDto, { type: 'event' }>): string {
  const record = asRecord(node.payload)
  return normalizeLifecycleAction(stringField(record, 'event', 'action', 'type', 'status') ?? '')
}

function isReviewTerminal(node: ReviewNodeDto): boolean {
  if (node.type !== 'event' || node.kind !== 'session.lifecycle') return false
  return ['turn.completed', 'turn.complete', 'turn.ended', 'turn.end', 'turn.stopped', 'turn.stop', 'turn.aborted', 'turn.error']
    .includes(reviewEventAction(node))
}

function reviewTurnSections(nodes: readonly ReviewNodeDto[]): ReviewTurnSection[] {
  let lastProcessDriver = -1
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!
    if (node.type === 'message' && node.role === 'user') continue
    if (node.type === 'message' && node.role === 'assistant') continue
    if (node.type === 'event' && node.category === 'artifact') continue
    if (isReviewTerminal(node)) continue
    lastProcessDriver = index
  }

  return nodes.map((node, index) => {
    if (node.type === 'message' && node.role === 'user') return 'prompt'
    if (node.type === 'event' && node.category === 'artifact') return 'artifact'
    if (isReviewTerminal(node)) return 'terminal'
    if (node.type === 'message' && node.role === 'assistant' && index > lastProcessDriver) return 'final'
    return 'process'
  })
}

function nodeStartMs(node: ReviewNodeDto): number | undefined {
  const value = node.type === 'tool' ? node.startedAt : node.at
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function nodeEndMs(node: ReviewNodeDto): number | undefined {
  if (node.type === 'tool') {
    const ended = node.endedAt ? Date.parse(node.endedAt) : Number.NaN
    if (Number.isFinite(ended)) return ended
    const started = nodeStartMs(node)
    return started !== undefined && node.durationMs !== undefined ? started + node.durationMs : started
  }
  return nodeStartMs(node)
}

function processSummary(interaction: ReviewInteractionDto): ReviewProcessSummaryDto {
  const sections = reviewTurnSections(interaction.nodes)
  const processNodes = interaction.nodes.filter((_, index) => sections[index] === 'process')
  const messages = processNodes.filter(node => node.type === 'message')
  const tools = processNodes.filter((node): node is Extract<ReviewNodeDto, { type: 'tool' }> => node.type === 'tool')
  const starts = processNodes.map(nodeStartMs).filter((value): value is number => value !== undefined)
  const ends = processNodes.map(nodeEndMs).filter((value): value is number => value !== undefined)
  const startedAt = starts.length ? Math.min(...starts) : undefined
  const endedAt = ends.length ? Math.max(...ends) : undefined
  const returnedNodeCount = interaction.nodes.length
  const totalFactCount = interaction.totalNodeCount ?? returnedNodeCount
  const boundedOmittedFactCount = Math.max(0, totalFactCount - MAX_REVIEW_INTERACTION_NODES)
  const omittedFactCount = interaction.omittedNodeCount
    ?? Math.max(0, totalFactCount - returnedNodeCount, boundedOmittedFactCount)
  const last = interaction.nodes.at(-1)
  return {
    id: `process:${interaction.id}`,
    revision: [interaction.id, totalFactCount, last?.id ?? 'empty', last?.capturedAt ?? interaction.endedAt].join(':'),
    itemCount: processNodes.length,
    messageCount: messages.length,
    toolCount: tools.length,
    errorCount: tools.filter(tool => tool.status === 'error').length,
    durationMs: startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : 0,
    availability: interaction.nodesTruncated || returnedNodeCount > MAX_REVIEW_INTERACTION_NODES || omittedFactCount > 0 ? 'partial' : 'available',
    totalFactCount,
    ...(omittedFactCount > 0 ? { omittedFactCount } : {}),
  }
}

function withProcessSummaries(detail: ReviewSessionDetailDto): ReviewSessionDetailDto {
  return {
    ...detail,
    interactions: detail.interactions.map(interaction => {
      const summary = processSummary(interaction)
      return {
        ...interaction,
        processSummary: summary,
        processMode: 'full',
      }
    }),
  }
}

function summarizeProcessNodes(detail: ReviewSessionDetailDto): ReviewSessionDetailDto {
  return {
    ...detail,
    interactions: detail.interactions.map(interaction => {
      const sections = reviewTurnSections(interaction.nodes)
      const nodes = interaction.nodes.filter((node, index) => {
        const section = sections[index]
        if (section !== 'process') return true
        return node.type === 'event' && (node.kind === 'model.changed' || node.kind === 'model.call')
      })
      return {
        ...interaction,
        nodes,
        processMode: 'summary',
      }
    }),
  }
}

export function lifecycleEventLabel(payload: JsonValue | unknown): string {
  const record = asRecord(payload)
  const raw = stringField(record, 'event', 'action', 'type', 'status') ?? ''
  const action = normalizeLifecycleAction(raw)

  const exact: Record<string, string> = {
    'session.created': '创建会话',
    'session.create': '创建会话',
    'session.initialized': '会话初始化',
    'session.initialize': '会话初始化',
    'session.started': '会话开始',
    'session.start': '会话开始',
    started: '会话开始',
    start: '会话开始',
    'session.resumed': '恢复会话',
    'session.resume': '恢复会话',
    resumed: '恢复会话',
    resume: '恢复会话',
    'session.continued': '继续会话',
    'session.continue': '继续会话',
    continued: '继续会话',
    continue: '继续会话',
    'session.restarted': '重新开始会话',
    'session.restart': '重新开始会话',
    restarted: '重新开始会话',
    restart: '重新开始会话',
    'session.discovered': '发现会话',
    'session.discover': '发现会话',
    discovered: '发现会话',
    discover: '发现会话',
    'session.paused': '会话暂停',
    'session.pause': '会话暂停',
    paused: '会话暂停',
    pause: '会话暂停',
    'session.interrupted': '会话中断',
    'session.interrupt': '会话中断',
    interrupted: '会话中断',
    interrupt: '会话中断',
    'session.cancelled': '会话取消',
    'session.canceled': '会话取消',
    'session.cancel': '会话取消',
    cancelled: '会话取消',
    canceled: '会话取消',
    cancel: '会话取消',
    'session.aborted': '会话终止',
    'session.abort': '会话终止',
    aborted: '会话终止',
    abort: '会话终止',
    'session.ended': '会话结束',
    'session.end': '会话结束',
    'session.closed': '会话结束',
    'session.close': '会话结束',
    ended: '会话结束',
    end: '会话结束',
    closed: '会话结束',
    close: '会话结束',
    'turn.started': '轮次开始',
    'turn.start': '轮次开始',
    'turn.completed': '轮次结束',
    'turn.complete': '轮次结束',
    'turn.stopped': '轮次停止',
    'turn.stop': '轮次停止',
    'turn.aborted': '轮次终止',
    'turn.error': '轮次错误',
    stopped: '轮次停止',
    stop: '轮次停止',
    'turn.ended': '轮次结束',
    'turn.end': '轮次结束',
    'review.entered': '进入审查',
    'review.exited': '退出审查',
    'subagent.interacted': '子 Agent 活动',
    'subagent.communication': '子 Agent 通信',
    'reasoning.configuration.updated': '推理配置更新',
    'thread.goal.updated': '任务目标更新',
    'thread.rolled.back': '会话回滚',
    'thread.settings.applied': '会话设置更新',
  }
  if (exact[action]) return exact[action]

  const parts = new Set(action.split('.').filter(Boolean))
  const has = (...values: string[]) => values.some(value => parts.has(value))
  if (has('resume', 'resumed')) return '恢复会话'
  if (has('restart', 'restarted')) return '重新开始会话'
  if (has('continue', 'continued')) return '继续会话'
  if (has('discover', 'discovered')) return '发现会话'
  if (has('initialize', 'initialized', 'init')) return '会话初始化'
  if (has('create', 'created')) return '创建会话'
  if (has('pause', 'paused')) return '会话暂停'
  if (has('interrupt', 'interrupted')) return '会话中断'
  if (has('cancel', 'cancelled', 'canceled')) return '会话取消'
  if (has('abort', 'aborted')) return '会话终止'
  if (parts.has('turn') && has('start', 'started')) return '轮次开始'
  if (parts.has('turn') && has('stop', 'stopped')) return '轮次停止'
  if (parts.has('turn') && has('end', 'ended', 'complete', 'completed')) return '轮次结束'
  if (has('start', 'started')) return '会话开始'
  if (has('stop', 'stopped', 'end', 'ended', 'close', 'closed')) return '会话结束'

  return '会话状态变化'
}

function boundInteractionNodes(interaction: ReviewInteractionDto): ReviewInteractionDto {
  if (interaction.nodes.length <= MAX_REVIEW_INTERACTION_NODES) return interaction
  const totalNodeCount = interaction.nodes.length
  return {
    ...interaction,
    nodes: [
      ...interaction.nodes.slice(0, REVIEW_INTERACTION_HEAD_NODES),
      ...interaction.nodes.slice(-REVIEW_INTERACTION_TAIL_NODES),
    ],
    nodesTruncated: true,
    totalNodeCount,
    omittedNodeCount: totalNodeCount - MAX_REVIEW_INTERACTION_NODES,
  }
}

function boundReviewDetail(detail: ReviewSessionDetailDto): ReviewSessionDetailDto {
  return {
    ...detail,
    interactions: detail.interactions.map(boundInteractionNodes),
  }
}

function normalizeOrphanToolResults(detail: ReviewSessionDetailDto): ReviewSessionDetailDto {
  return {
    ...detail,
    interactions: detail.interactions.map(interaction => ({
      ...interaction,
      nodes: interaction.nodes.map(node => {
        if (node.type !== 'event' || node.kind !== 'tool.result') return node
        const payload = asRecord(node.payload)
        const callId = stringField(payload, 'callId', 'call_id', 'toolUseId', 'tool_use_id')
        const name = stringField(payload, 'nativeToolName', 'toolName', 'tool_name', 'name') ?? 'Tool'
        const rawDuration = payload.durationMs ?? payload.duration_ms
        const durationMs = typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0
          ? rawDuration
          : undefined
        const status = payload.success === false
          ? 'error' as const
          : payload.success === true
            ? 'success' as const
            : 'unknown' as const
        const output = payload.output !== undefined
          ? payload.output
          : payload.result !== undefined
            ? payload.result
            : node.payload
        return {
          type: 'tool' as const,
          id: node.id,
          at: node.at,
          sourceId: node.sourceId,
          name,
          ...(callId ? { callId } : {}),
          status,
          startedAt: node.at,
          endedAt: node.at,
          ...(durationMs === undefined ? {} : { durationMs }),
          output,
          payload: node.payload,
          evidence: node.evidence,
          observationIds: node.observationIds,
          ...(node.nativeEventId ? { nativeEventId: node.nativeEventId } : {}),
          ...(node.nativeParentEventId ? { nativeParentEventId: node.nativeParentEventId } : {}),
          ...(node.parentObservationId ? { parentObservationId: node.parentObservationId } : {}),
          ...(node.occurredAt ? { occurredAt: node.occurredAt } : {}),
          capturedAt: node.capturedAt,
        }
      }),
    })),
  }
}

function localizeLifecycle(detail: ReviewSessionDetailDto): ReviewSessionDetailDto {
  return {
    ...detail,
    interactions: detail.interactions.map(interaction => ({
      ...interaction,
      nodes: interaction.nodes.map(node => node.type === 'event' && node.kind === 'session.lifecycle'
        ? { ...node, label: lifecycleEventLabel(node.payload) }
        : node),
    })),
  }
}

type ReviewSessionActivity = ReviewSessionSummaryDto['sessionActivity']

function resolveSessionActivity(
  attributed: ReviewSessionActivity | undefined,
  userTurnCount: number | undefined,
  systemContextCount: number | undefined,
): ReviewSessionActivity | undefined {
  if (attributed === 'branch-task' || attributed === 'subagent' || attributed === 'internal-review') {
    return attributed
  }
  if ((userTurnCount ?? 0) > 0) return 'user-task'
  if (attributed === 'system-activity' || (systemContextCount ?? 0) > 0) return 'system-activity'
  return attributed
}

function normalizeReviewSummaryActivity<T extends ReviewSessionSummaryDto>(summary: T): T {
  const sessionActivity = resolveSessionActivity(
    summary.sessionActivity,
    summary.userTurnCount,
    summary.systemContextCount,
  )
  if (sessionActivity === summary.sessionActivity) return summary
  return {
    ...summary,
    ...(sessionActivity ? { sessionActivity } : {}),
  }
}

export class ReviewProjection extends BaseReviewProjection {
  override async query(query: ReviewQueryDto = {}): Promise<ReviewResponseDto> {
    const response = await super.query(query)
    return {
      ...response,
      items: response.items.map(normalizeReviewSummaryActivity),
    }
  }

  override async get(
    logicalSessionId: string,
    query: ReviewDetailQueryDto = {},
  ): Promise<ReviewSessionDetailDto | null> {
    const detail = await super.get(logicalSessionId, query)
    if (!detail) return null

    const normalized = normalizeReviewSummaryActivity(
      localizeLifecycle(normalizeOrphanToolResults(detail)),
    )
    if (query.process === 'summary') return normalized
    return boundReviewDetail(withProcessSummaries(normalized))
  }
}

export const reviewProjectionInternals = {
  ...baseReviewProjectionInternals,
  lifecycleEventLabel,
  reviewTurnSections,
  processSummary,
  summarizeProcessNodes,
  localizeLifecycle,
  normalizeOrphanToolResults,
  boundInteractionNodes,
  boundReviewDetail,
  resolveSessionActivity,
  normalizeReviewSummaryActivity,
  maxReviewInteractionNodes: MAX_REVIEW_INTERACTION_NODES,
  reviewInteractionHeadNodes: REVIEW_INTERACTION_HEAD_NODES,
  reviewInteractionTailNodes: REVIEW_INTERACTION_TAIL_NODES,
}
