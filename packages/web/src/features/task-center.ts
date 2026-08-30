import type { ProjectFacetDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'

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
