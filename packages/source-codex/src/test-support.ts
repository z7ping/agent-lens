import type { SourceNormalizationContext } from '@agent-lens/core'

export const codexTestContext: SourceNormalizationContext = {
  host: {
    id: 'host',
    name: 'host',
    platform: 'linux',
    arch: 'x64',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  },
  installation: {
    id: 'install',
    hostId: 'host',
    productId: 'codex',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  },
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
