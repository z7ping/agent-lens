import type { ProjectFacetDto } from '@agent-lens/protocol'

/** 本地项目身份包含主机 ID；界面只展示其中的工作目录。 */
export function projectDisplayIdentity(identity: string | undefined): string | undefined {
  if (!identity) return undefined
  return /^local-workspace:[^:]+:(.+)$/s.exec(identity)?.[1] ?? identity
}

export function projectDisplayLabel(project: ProjectFacetDto): string {
  return project.name ?? projectDisplayIdentity(project.repositoryIdentity) ?? project.id
}

export function projectSelectOption(project: ProjectFacetDto) {
  const description = projectDisplayIdentity(project.repositoryIdentity)
  return {
    value: project.id,
    label: projectDisplayLabel(project),
    ...(description ? { description } : {}),
  }
}
