import type { AgentLensPluginManifest } from './plugin'

export interface StorageProviderManifest extends AgentLensPluginManifest {
  pluginType: 'storage'
  providerId: string
  engine: string
}

export interface StorageProviderDefinition<TConfig = unknown, TStorage = unknown> {
  manifest: StorageProviderManifest
  create(config: TConfig): TStorage | Promise<TStorage>
  initialize?(storage: TStorage, config: TConfig): void | Promise<void>
  dispose(storage: TStorage): void | Promise<void>
}

export function defineStorageProvider<TConfig, TStorage>(
  definition: StorageProviderDefinition<TConfig, TStorage>,
): StorageProviderDefinition<TConfig, TStorage> {
  return definition
}
