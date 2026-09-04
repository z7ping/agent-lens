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

function legacySystemActivity(value: string): ReviewSessionSummaryDto['sessionActivity'] | undefined {
  if (/^The following is the Codex agent history whose request action you are assessing\./i.test(value)) return 'internal-review'
  if (/^(?:<recommended_plugins>|<app-context>|# AGENTS\.md instructions\b)/i.test(value)) return 'system-activity'
  return undefined
}

/**
 * 会话列表保留所有活动，但不会把系统注入或内部审查正文伪装成用户任务标题。
 * legacySystemActivity 只覆盖旧数据中尚未持久化 sessionActivity 的明确系统前缀。
 */
export function historyTaskPresentation(
  item: ReviewSessionSummaryDto,
  fallback: string,
): HistoryTaskPresentation {
  const rawTitle = item.title || item.preview || ''
  const activity = item.sessionActivity ?? legacySystemActivity(rawTitle.trim())
  if (!activity || activity === 'user-task') return { title: cleanSessionTitle(rawTitle, fallback) }

  if (activity === 'internal-review') {
    return { title: 'Codex 会话评估', activityLabel: item.activitySourceLabel || '内部审查' }
  }
  if (activity === 'system-activity') {
    const title = /^<recommended_plugins>/i.test(rawTitle.trim())
      ? '推荐插件与运行规则'
      : /^<app-context>/i.test(rawTitle.trim())
        ? '应用上下文与运行规则'
        : '系统注入上下文'
    return { title, activityLabel: item.activitySourceLabel || '系统活动' }
  }
  if (activity === 'subagent') {
    return { title: cleanSessionTitle(rawTitle, '子智能体运行记录'), activityLabel: item.activitySourceLabel || '子智能体' }
  }
  return { title: cleanSessionTitle(rawTitle, '分支任务记录'), activityLabel: item.activitySourceLabel || '分支任务' }
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
