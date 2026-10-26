import type { AssetInventoryEntry } from '@agent-lens/core'
import type { AgentAssetInventoryDto, AgentAssetStateDto } from '@agent-lens/protocol'

const CURRENT_ASSET_PRESENCE_STATES = new Set(['installed', 'configured', 'enabled', 'discoverable', 'exposed'])

function latestStates(entry: AssetInventoryEntry): AgentAssetStateDto[] {
  const latest = new Map<string, AgentAssetStateDto>()
  for (const state of entry.states) {
    if (latest.has(state.state)) continue
    latest.set(state.state, {
      state: state.state,
      value: state.value,
      observedAt: state.observedAt,
      evidenceCount: state.evidenceRefs.length,
    })
  }
  return [...latest.values()].sort((a, b) => a.state.localeCompare(b.state))
}

function bindingIsCurrent(states: readonly AgentAssetStateDto[]): boolean {
  const presence = states.filter(state => CURRENT_ASSET_PRESENCE_STATES.has(state.state))
  if (presence.some(state => state.value === true)) return true
  if (presence.some(state => state.value === false)) return false
  return true
}

/** Project current asset state for native Agent views. */
export function projectAgentAssetInventory(pages: readonly (readonly AssetInventoryEntry[])[]): AgentAssetInventoryDto[] {
  const inventory = new Map<string, AgentAssetInventoryDto>()
  for (const entries of pages) {
    for (const entry of entries) {
      const states = latestStates(entry)
      if (!bindingIsCurrent(states)) continue
      let asset = inventory.get(entry.definition.id)
      if (!asset) {
        asset = {
          id: entry.definition.id,
          type: entry.definition.type,
          canonicalName: entry.definition.canonicalName,
          ...(entry.definition.displayName ? { displayName: entry.definition.displayName } : {}),
          ...(entry.definition.upstreamIdentity ? { upstreamIdentity: entry.definition.upstreamIdentity } : {}),
          bindings: [],
        }
        inventory.set(entry.definition.id, asset)
      }
      asset.bindings.push({
        id: entry.binding.id,
        installationId: entry.binding.installationId,
        ...(entry.binding.scope ? { scope: entry.binding.scope } : {}),
        ...(entry.binding.scopeRoot ? { scopeRoot: entry.binding.scopeRoot } : {}),
        ...(entry.binding.path ? { path: entry.binding.path } : {}),
        ...(entry.binding.source ? { source: entry.binding.source } : {}),
        ...(entry.binding.version ? { version: entry.binding.version } : {}),
        states,
      })
    }
  }

  const assetInventory = [...inventory.values()]
  for (const asset of assetInventory) {
    asset.bindings.sort((a, b) => (a.path ?? a.source ?? a.id).localeCompare(b.path ?? b.source ?? b.id))
  }
  assetInventory.sort((a, b) => a.type.localeCompare(b.type)
    || (a.displayName ?? a.canonicalName).localeCompare(b.displayName ?? b.canonicalName))

  return assetInventory
}
