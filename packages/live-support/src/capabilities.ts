import type { LiveCapabilityName } from '@agent-lens/core'

export function createLiveCapabilitySet(
  capabilities: readonly LiveCapabilityName[],
): ReadonlySet<LiveCapabilityName> {
  const unique = new Set<LiveCapabilityName>()
  for (const capability of capabilities) {
    if (unique.has(capability)) {
      throw new Error(`Duplicate Live capability: ${capability}`)
    }
    unique.add(capability)
  }
  return unique
}

export function requireLiveCapability(
  capabilities: ReadonlySet<LiveCapabilityName>,
  capability: LiveCapabilityName,
  liveId = 'live adapter',
): void {
  if (!capabilities.has(capability)) {
    throw new Error(`${liveId} does not support Live capability: ${capability}`)
  }
}
