import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'
import { startLocalVault } from './standalone'

export interface BackupLocalPluginConfig {
  vaultPath?: string
}

function configuredSourceOrder(ctx: AgentLensContext): string[] {
  const configured = ctx.capturePolicy.settings.enabledSources
  const registered = ctx.sources.list().map(source => source.manifest.sourceId)
  return [...new Set([
    ...configured,
    ...registered.filter(sourceId => !configured.includes(sourceId)),
  ])]
}

const applyBackupLocal: Plugin.Function<BackupLocalPluginConfig> = (
  ctx: AgentLensContext,
  config: BackupLocalPluginConfig = {},
) => {
  const vaultPath = config.vaultPath ?? join(homedir(), '.agent-lens', '1.0', 'vault')
  const sourceOrder = configuredSourceOrder(ctx)
  const vault = startLocalVault(ctx.storage, ctx.sources, ctx.identity, {
    vaultPath, sourceOrder,
  })
  const dispose = ctx.provide('backup', vault.service)
  return () => {
    vault.stop()
    dispose()
  }
}

applyBackupLocal.inject = ['storage', 'sources', 'identity', 'capturePolicy']

/** First-party Cordis runtime service. Backup files are not canonical observations. */
export const backupLocalPlugin = applyBackupLocal
