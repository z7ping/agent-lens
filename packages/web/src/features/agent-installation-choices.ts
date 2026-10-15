import type { AgentInstallationOverviewDto } from '@agent-lens/protocol'

/** Collapse duplicated choices, not installation records or their asset bindings.
 * A different version or visible directory is a distinct selectable environment.
 */
export function installationChoices(
  installations: readonly AgentInstallationOverviewDto[],
): AgentInstallationOverviewDto[] {
  const seen = new Set<string>()
  return installations.filter(item => {
    const key = installationChoiceKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Keep every backing installation ID reachable for duplicated display choices. */
export function installationChoiceKey(item: AgentInstallationOverviewDto): string {
  const path = (item.configRoot ?? item.dataRoot ?? item.executable ?? item.id)
    .trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const directory = /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLocaleLowerCase() : path
  return JSON.stringify([item.version?.trim() ?? '', directory])
}
