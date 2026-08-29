import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'
import { ExplainableBackupService } from './explainability'
import { LocalBackupService } from './service'
import { StaleWhileRevalidateBackupService } from './stale-while-revalidate'

export interface BackupLocalPluginConfig {
  vaultPath?: string
}

const applyBackupLocal: Plugin.Function<BackupLocalPluginConfig> = (
  ctx: AgentLensContext,
  config: BackupLocalPluginConfig = {},
) => {
  const vaultPath = config.vaultPath ?? join(homedir(), '.agent-lens', '1.0', 'vault')
  const localService = new LocalBackupService(
    ctx.storage,
    ctx.sources,
    ctx.identity,
    { vaultPath },
  )
  const explainable = new ExplainableBackupService(localService, join(vaultPath, 'inventory-v1.json'))
  const service = new StaleWhileRevalidateBackupService(explainable, { vaultPath })

  // 不再启动 LocalBackupService 自己的 5 分钟全量扫描定时器。
  // SWR 层负责旧索引立即可用、访问时后台重验证和 30 分钟低频安全兜底。
  service.start()
  const dispose = ctx.provide('backup', service)
  return () => {
    service.stop()
    localService.stop()
    dispose()
  }
}

applyBackupLocal.inject = ['storage', 'sources', 'identity']

/** First-party Cordis runtime service. Backup files are not canonical observations. */
export const backupLocalPlugin = applyBackupLocal
