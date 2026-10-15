import type { AgentInstallationOverviewDto } from '@agent-lens/protocol'

/** Collapse duplicated choices, not installation records or their asset bindings.
 * A different version or visible directory is a distinct selectable environment.
 */
export function installationChoices(
  installations: readonly AgentInstallationOverviewDto[],
): AgentInstallationOverviewDto[] {
  const seen = new Set<string>()
  return installations.filter(item => {
    const directory = (item.configRoot ?? item.dataRoot ?? item.executable ?? item.id)
      .trim().replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase()
    const key = JSON.stringify([item.version?.trim() ?? '', directory])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
