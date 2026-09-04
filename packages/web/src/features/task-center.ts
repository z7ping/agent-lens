import type { ProjectFacetDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'

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

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

function timestamp(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

function cleanSessionTitle(value: string | undefined, fallback: string): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (!text) return fallback
  return text.length > 74 ? `${text.slice(0, 74)}…` : text
}

function userTaskTitle(item: ReviewSessionSummaryDto): string | undefined {
  // Codex 的 legacy session_index.thread_name 是来源原生会话标签，但当前格式无法证明
  // 它一定来自显式 /rename；它也可能由应用注入上下文派生。真实 event_msg.user_message
  // 已由 Source Adapter 归一为 preview，因此 Codex 用户任务优先使用该结构化用户请求。
  // 这里按来源语义选择候选，不检查正文内容，也不做任何关键词/标签黑名单。
  if (item.sourceIds.includes('codex') && item.preview?.trim()) return item.preview
  return item.title || item.preview
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
    return { title: '内部审查活动', activityLabel: item.activitySourceLabel || '内部审查' }
  }
  if (activity === 'system-activity') {
    return { title: item.activitySourceLabel || '系统活动', activityLabel: '系统活动' }
  }
  if (activity === 'subagent') {
    return {
      title: cleanSessionTitle(item.activitySourceLabel || item.title || item.preview, '子智能体运行记录'),
      activityLabel: '子智能体',
    }
  }
  return {
    title: cleanSessionTitle(item.title || item.preview, '分支任务记录'),
    activityLabel: item.activitySourceLabel || '分支任务',
  }
}

/**
 * 新建任务只消费 AgentLens 已经从真实会话观测到的 workspacePath。
 * ProjectFacet 本身不携带路径，因此不得根据项目名猜目录，更不能要求用户手敲 cwd。
 */
export function deriveTaskProjectOptions(
  projects: ProjectFacetDto[],
  sessions: ReviewSessionSummaryDto[],
): TaskProjectOption[] {
  const projectById = new Map(projects.map(project => [project.id, project]))
  const byKey = new Map<string, TaskProjectOption>()

  for (const session of sessions) {
    const cwd = session.workspacePath?.trim()
    if (!cwd) continue
    const project = session.projectId ? projectById.get(session.projectId) : undefined
    const key = session.projectId ? `project:${session.projectId}` : `workspace:${cwd}`
    const label = project?.name?.trim()
      || session.projectName?.trim()
      || project?.repositoryIdentity?.trim()
      || basename(cwd)
      || '未命名项目'
    const next: TaskProjectOption = {
      key,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      label,
      cwd,
      lastSeenAt: session.endedAt || session.startedAt,
    }
    const current = byKey.get(key)
    if (!current || timestamp(next.lastSeenAt) >= timestamp(current.lastSeenAt)) byKey.set(key, next)
  }

  return [...byKey.values()].sort((left, right) => timestamp(right.lastSeenAt) - timestamp(left.lastSeenAt))
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
