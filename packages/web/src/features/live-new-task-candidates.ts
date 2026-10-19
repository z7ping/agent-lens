import type { IntegrationManagementItemDto, LiveProductDto } from '@agent-lens/protocol'
import { integrationPackageUpdateAvailable } from './integrations/integration-lifecycle'

export type MissingCodexLiveReason =
  | 'not-installed' | 'needs-update' | 'disabled' | 'needs-restart'
  | 'needs-authorization' | 'registration-failed'

/** Explain why a supported Live adapter is absent without pretending it is executable. */
export function missingCodexLiveReason(item: IntegrationManagementItemDto): MissingCodexLiveReason {
  const pack = item.packageState
  if (!pack?.installed) return 'not-installed'
  if (pack.integrity !== 'verified' || pack.compatibility !== 'compatible'
    || integrationPackageUpdateAvailable(pack)) return 'needs-update'
  if (!item.enabled.configured || !item.enabled.effective) return 'disabled'
  if (item.enabled.restartRequired || pack.restartRequired) return 'needs-restart'
  const live = item.capabilities.find(capability => capability.capability === 'live')
  if (live?.authorization === 'required' || live?.reasonCode === 'authorization-required') {
    return 'needs-authorization'
  }
  if (live?.reasonCode === 'authorization-restart-required') return 'needs-restart'
  return 'registration-failed'
}

/** Show the missing Codex Live entry as unavailable, never as an active adapter.
 * The actual service's registered adapter descriptor always takes precedence.
 */
export function withMissingCodexLive(
  products: readonly LiveProductDto[],
  codex: IntegrationManagementItemDto | undefined,
  reason: string,
): LiveProductDto[] {
  if (!codex || products.some(product => product.liveId === 'codex' || product.productId === 'codex')) {
    return [...products]
  }
  return [
    ...products,
    {
      liveId: 'codex',
      productId: 'codex',
      displayName: 'Codex Live',
      capabilities: ['create'],
      inputCapabilities: {
        text: 'native',
        largeText: 'transform',
        image: 'unsupported',
        file: 'unsupported',
        multiline: 'native',
      },
      startCapabilities: { workspace: 'required', title: 'optional' },
      availability: { available: false, reason },
      runtimes: [],
    },
  ]
}
