import type { AgentAssetBindingDto, AgentInstallationOverviewDto } from '@agent-lens/protocol'

function directoryKey(value: string): string {
  const path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path
}

/** 配置目录只展示一次；保留底层安装记录，用于合并资源绑定。 */
export function installationChoices(
  installations: readonly AgentInstallationOverviewDto[],
): AgentInstallationOverviewDto[] {
  const choices = new Map<string, AgentInstallationOverviewDto>()
  for (const item of installations) {
    const key = installationChoiceKey(item)
    const previous = choices.get(key)
    if (!previous || item.lastSeenAt > previous.lastSeenAt
      || (item.lastSeenAt === previous.lastSeenAt && !previous.version && item.version)) choices.set(key, item)
  }
  return [...choices.values()]
}

/** 同目录的历史版本与缺失版本共用一个选项，资源绑定仍可追溯所有安装 ID。 */
export function installationChoiceKey(item: AgentInstallationOverviewDto): string {
  return directoryKey(item.configRoot ?? item.dataRoot ?? item.executable ?? item.id)
}

/** 同文件、同作用范围只展示最近的关联，历史安装 ID 不生成重复位置选项。 */
export function assetBindingChoices(bindings: readonly AgentAssetBindingDto[]): AgentAssetBindingDto[] {
  const choices = new Map<string, AgentAssetBindingDto>()
  const latest = (binding: AgentAssetBindingDto) => binding.states.reduce((date, state) => state.observedAt > date ? state.observedAt : date, '')
  for (const binding of bindings) {
    const key = binding.path
      ? JSON.stringify([binding.scope, directoryKey(binding.scopeRoot ?? ''), directoryKey(binding.path)])
      : binding.id
    const previous = choices.get(key)
    if (!previous || latest(binding) > latest(previous)) choices.set(key, binding)
  }
  return [...choices.values()]
}
