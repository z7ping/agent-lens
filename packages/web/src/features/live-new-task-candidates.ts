import type { IntegrationManagementItemDto, LiveProductDto } from '@agent-lens/protocol'
import { integrationPackageUpdateAvailable } from './integrations/integration-lifecycle'

export type MissingIntegrationLiveReason =
  | 'not-installed' | 'needs-update' | 'disabled' | 'needs-restart'
  | 'needs-authorization' | 'registration-failed'

/** Missing Live is an Integration lifecycle fact, never a provider ID heuristic. */
export function missingIntegrationLiveReason(item: IntegrationManagementItemDto): MissingIntegrationLiveReason {
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

/** Synthetic selection identity, never an executable Live Adapter ID. */
export function unregisteredLiveId(item: IntegrationManagementItemDto): string {
  return `unregistered:${item.integrationId}`
}

/** All missing integrations use the same read-only onboarding presentation.
 * The adapter-owned product descriptor always takes precedence.
 */
export function withUnregisteredIntegrationLives(
  products: readonly LiveProductDto[],
  integrations: readonly IntegrationManagementItemDto[],
  reason: (item: IntegrationManagementItemDto) => string,
): LiveProductDto[] {
  return [
    ...products,
    ...integrations
      .filter(item => item.capabilities.some(capability => capability.capability === 'live')
        && !products.some(product => product.productId === item.productId))
      .map(item => ({
        liveId: unregisteredLiveId(item),
        productId: item.productId,
        displayName: item.displayName,
        // Registration has failed: never invent a runnable capability or
        // guess this adapter's native input/start behavior.
        capabilities: [],
        inputCapabilities: {
          text: 'unsupported' as const, largeText: 'unsupported' as const,
          image: 'unsupported' as const, file: 'unsupported' as const,
          multiline: 'unsupported' as const,
        },
        startCapabilities: {
          workspace: 'unsupported' as const, title: 'unsupported' as const,
        },
        availability: { available: false, reason: reason(item) },
        runtimes: [],
      })),
  ]
}
