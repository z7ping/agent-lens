import type {
  JsonValue,
  ReviewDetailQueryDto,
  ReviewInteractionDto,
  ReviewQueryDto,
  ReviewResponseDto,
  ReviewSessionDetailDto,
  ReviewSessionSummaryDto,
} from '@agent-lens/protocol'
import {
  ReviewProjection as BaseReviewProjection,
  reviewProjectionInternals as baseReviewProjectionInternals,
} from './projection'

export { HubReviewProjection, hubReviewProjectionInternals } from './hub'

const MAX_REVIEW_INTERACTION_NODES = 600
const REVIEW_INTERACTION_HEAD_NODES = 240
const REVIEW_INTERACTION_TAIL_NODES = MAX_REVIEW_INTERACTION_NODES - REVIEW_INTERACTION_HEAD_NODES

function asRecord(value: JsonValue | unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function normalizeLifecycleAction(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_:\-]+/g, '.')
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
    'turn.stopped': '轮次停止',
    'turn.stop': '轮次停止',
    stopped: '轮次停止',
    stop: '轮次停止',
    'turn.ended': '轮次结束',
    'turn.end': '轮次结束',
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
  if (parts.has('turn') && has('end', 'ended')) return '轮次结束'
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
    return detail
      ? normalizeReviewSummaryActivity(localizeLifecycle(boundReviewDetail(detail)))
      : null
  }
}

export const reviewProjectionInternals = {
  ...baseReviewProjectionInternals,
  lifecycleEventLabel,
  localizeLifecycle,
  boundInteractionNodes,
  boundReviewDetail,
  resolveSessionActivity,
  normalizeReviewSummaryActivity,
  maxReviewInteractionNodes: MAX_REVIEW_INTERACTION_NODES,
  reviewInteractionHeadNodes: REVIEW_INTERACTION_HEAD_NODES,
  reviewInteractionTailNodes: REVIEW_INTERACTION_TAIL_NODES,
}
