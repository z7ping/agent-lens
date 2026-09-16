import type {
  LiveCapabilityName,
  LiveInputCapabilities,
  LiveInputSupport,
} from '@agent-lens/core'

const LIVE_INPUT_SUPPORT = new Set<LiveInputSupport>([
  'native',
  'transform',
  'unsupported',
])

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

export function createLiveInputCapabilities(
  capabilities: LiveInputCapabilities,
): Readonly<LiveInputCapabilities> {
  for (const [name, support] of Object.entries(capabilities)) {
    if (!LIVE_INPUT_SUPPORT.has(support as LiveInputSupport)) {
      throw new Error(`Invalid Live input capability ${name}: ${String(support)}`)
    }
  }
  return Object.freeze({ ...capabilities })
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
