import { join } from 'node:path'
import type {
  BackupService, IdentityService, SourceService, StorageService,
} from '@agent-lens/core'
import { ExplainableBackupService } from './explainability'
import { LocalBackupService } from './service'
import { StaleWhileRevalidateBackupService } from './stale-while-revalidate'

export interface LocalVaultOptions {
  vaultPath: string
  sourceOrder?: string[]
}

/**
 * The only Local Vault composition, shared by Legacy's Cordis plugin and
 * the replacement Slim Daemon. Original Source files remain authoritative,
 * and backup index/checkpoints never write Canonical observations/events.
 */
export function startLocalVault(
  storage: Pick<StorageService, 'checkpoints'>,
  sources: SourceService,
  identity: Pick<IdentityService, 'resolveHost' | 'resolveInstallation'>,
  options: LocalVaultOptions,
): { service: BackupService; stop(): void } {
  const local = new LocalBackupService(storage, sources, identity, options)
  const explainable = new ExplainableBackupService(
    local, join(options.vaultPath, 'inventory-v1.json'),
  )
  const service = new StaleWhileRevalidateBackupService(explainable, options)
  service.start()
  return {
    service,
    stop() {
      service.stop()
      local.stop()
    },
  }
}
