import type {
  JsonValue,
  ReviewDetailQueryDto,
  ReviewSessionDetailDto,
} from '@agent-lens/protocol'
import {
  ReviewProjection as BaseReviewProjection,
  reviewProjectionInternals as baseReviewProjectionInternals,
} from './projection'

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

  if (action.includes('resume')) return '恢复会话'
  if (action.includes('restart')) return '重新开始会话'
  if (action.includes('continue')) return '继续会话'
  if (action.includes('discover')) return '发现会话'
  if (action.includes('initialize') || action.includes('init')) return '会话初始化'
  if (action.includes('create')) return '创建会话'
  if (action.includes('pause')) return '会话暂停'
  if (action.includes('interrupt')) return '会话中断'
  if (action.includes('cancel')) return '会话取消'
  if (action.includes('abort')) return '会话终止'
  if (action.startsWith('turn.') && action.includes('start')) return '轮次开始'
  if (action.startsWith('turn.') && (action.includes('stop') || action.includes('end'))) return '轮次停止'
  if (action.includes('start')) return '会话开始'
  if (action.includes('stop') || action.includes('end') || action.includes('close')) return '会话结束'

  return '会话状态变化'
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

export class ReviewProjection extends BaseReviewProjection {
  override async get(
    logicalSessionId: string,
    query: ReviewDetailQueryDto = {},
  ): Promise<ReviewSessionDetailDto | null> {
    const detail = await super.get(logicalSessionId, query)
    return detail ? localizeLifecycle(detail) : null
  }
}

export const reviewProjectionInternals = {
  ...baseReviewProjectionInternals,
  lifecycleEventLabel,
  localizeLifecycle,
}
