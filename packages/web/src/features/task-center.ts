import type { LaunchableProjectDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'

export interface HistoryTaskPresentation {
  title: string
  activityLabel?: string
}

export interface TaskProjectOption {
  key: string
  projectId?: string
  label: string
  cwd: string
  lastSeenAt: string
}

export function launchableTaskProjectOptions(items: readonly LaunchableProjectDto[]): TaskProjectOption[] {
  return items.map(item => ({
    key: item.key,
    ...(item.projectId ? { projectId: item.projectId } : {}),
    label: item.projectName?.trim()
      || item.repositoryIdentity?.trim()
      || basename(item.workspacePath)
      || translateProduct('task:center.presentation.unnamedProject'),
    cwd: item.workspacePath,
    lastSeenAt: item.lastSeenAt,
  }))
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

const namedTextEntities: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

function decodeTextEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named) return namedTextEntities[named.toLowerCase()] ?? match
    const codePoint = Number.parseInt(decimal ?? hex ?? '', hex ? 16 : 10)
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return match
    return String.fromCodePoint(codePoint)
  })
}

function cleanSessionTitle(value: string | undefined, fallback: string): string {
  const text = decodeTextEntities(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  return text.length > 74 ? `${text.slice(0, 74)}…` : text
}

/** 左侧会话列表的标题契约：只呈现任务名，不重复 Pi 工具标记或模型信息。 */
export function sessionListTitle(value: string | undefined, fallback: string, sourceIds: readonly string[] = []): string {
  const normalized = decodeTextEntities(value ?? '').replace(/\s+/g, ' ').trim()
  const withoutPiSuffix = sourceIds.includes('pi')
    ? normalized.replace(/\s*[·•]\s*Pi\s*$/i, '').trim()
    : normalized
  const text = withoutPiSuffix || fallback
  return text.length > 30 ? `${text.slice(0, 30)}…` : text
}

function userTaskTitle(item: ReviewSessionSummaryDto): string | undefined {
  // Codex 的 legacy session_index.thread_name 是来源原生会话标签，但当前格式无法证明
  // 它一定来自显式 /rename；它也可能由应用注入上下文派生。真实 event_msg.user_message
  // 已由 Source Adapter 归一为 preview，因此仅 Codex 用户任务优先使用该结构化用户请求。
  // 其他来源继续保留自身已经提供的原生会话标题，不用统一规则覆盖来源语义。
  if (item.sourceIds.includes('codex') && item.preview?.trim()) return item.preview
  return item.title || item.preview
}

function systemActivityTitle(item: ReviewSessionSummaryDto): string {
  if (item.activitySourceLabel?.trim()) return item.activitySourceLabel.trim()
  const scope = item.projectName?.trim()
    || (item.workspacePath ? basename(item.workspacePath) : '')
    || item.sourceIds[0]?.trim()
  return scope ? translateProduct('task:center.presentation.systemActivityScoped', { scope }) : translateProduct('task:center.presentation.systemActivity')
}

/**
 * 会话列表保留所有活动，但不会把系统注入或内部审查正文伪装成用户任务标题。
 * 活动类型和标题候选只消费 Canonical Pipeline 投影出的结构化字段，禁止根据正文猜来源。
 */
export function historyTaskPresentation(
  item: ReviewSessionSummaryDto,
  fallback: string,
): HistoryTaskPresentation {
  const activity = item.sessionActivity
  if (!activity || activity === 'user-task') {
    return { title: cleanSessionTitle(userTaskTitle(item), fallback) }
  }

  if (activity === 'internal-review') {
    return { title: translateProduct('task:center.presentation.internalReviewTitle'), activityLabel: item.activitySourceLabel || translateProduct('task:center.presentation.internalReviewLabel') }
  }
  if (activity === 'system-activity') {
    return { title: systemActivityTitle(item), activityLabel: translateProduct('task:center.presentation.systemActivity') }
  }
  if (activity === 'subagent') {
    return {
      title: cleanSessionTitle(item.activitySourceLabel || item.title || item.preview, translateProduct('task:center.presentation.subagentRecord')),
      activityLabel: translateProduct('task:center.presentation.subagentLabel'),
    }
  }
  return {
    title: cleanSessionTitle(item.title || item.preview, translateProduct('task:center.presentation.branchRecord')),
    activityLabel: item.activitySourceLabel || translateProduct('task:center.presentation.branchLabel'),
  }
}

export function pickTaskProject(
  options: TaskProjectOption[],
  preferredProjectId?: string,
  preferredWorkspacePath?: string,
): TaskProjectOption | undefined {
  if (preferredProjectId) {
    const byProject = options.find(option => option.projectId === preferredProjectId)
    if (byProject) return byProject
  }
  if (preferredWorkspacePath) {
    const byWorkspace = options.find(option => option.cwd === preferredWorkspacePath)
    if (byWorkspace) return byWorkspace
  }
  return options[0]
}
