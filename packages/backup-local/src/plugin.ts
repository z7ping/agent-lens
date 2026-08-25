import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'
import { LocalBackupService } from './service'

export interface BackupLocalPluginConfig {
  vaultPath?: string
}

const applyBackupLocal: Plugin.Function<BackupLocalPluginConfig> = (
  ctx: AgentLensContext,
  config: BackupLocalPluginConfig = {},
) => {
  const service = new LocalBackupService(
    ctx.storage,
    ctx.sources,
    ctx.identity,
    { vaultPath: config.vaultPath ?? join(homedir(), '.agent-lens', '1.0', 'vault') },
  )
  service.start()
  const dispose = ctx.provide('backup', service)
  return () => {
    service.stop()
    dispose()
  }
}

applyBackupLocal.inject = ['storage', 'sources', 'identity']

/** First-party Cordis runtime service. Backup files are not canonical observations. */
export const backupLocalPlugin = applyBackupLocal
