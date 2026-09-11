import type { CapturePolicyMode, CapturePolicySettings } from '@agent-lens/core'
import type { Plugin } from '@deepseek-ai/cordis'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'
import { DefaultCapturePolicyService, capturePolicySettingsFromEnv } from './service'
import {
  capturePolicyConfigurationPath,
  readCapturePolicyConfigurationSync,
  writeCapturePolicyConfiguration,
} from './configuration'

export interface CapturePolicyPluginConfig {
  prompt?: CapturePolicyMode
  tool?: CapturePolicyMode
  config?: CapturePolicyMode
  environment?: CapturePolicyMode
  enabledSources?: readonly string[]
}

export interface ResolvedCapturePolicyPluginState {
  settings: CapturePolicySettings
  configurationPath: string
  configurationSource: 'runtime' | 'environment' | 'file' | 'default'
  editable: boolean
}

export function resolveCapturePolicyPluginState(
  config: CapturePolicyPluginConfig = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedCapturePolicyPluginState {
  const defaults = capturePolicySettingsFromEnv(env)
  const configurationPath = capturePolicyConfigurationPath(env)
  const persisted = readCapturePolicyConfigurationSync(configurationPath)
  const environmentOverridesSources = env.AGENT_LENS_ENABLED_SOURCES !== undefined
  const enabledSources = config.enabledSources
    ?? (environmentOverridesSources
      ? defaults.enabledSources
      : persisted?.enabledSources ?? defaults.enabledSources)
  const settings: CapturePolicySettings = {
    prompt: config.prompt ?? defaults.prompt,
    tool: config.tool ?? defaults.tool,
    config: config.config ?? defaults.config,
    environment: config.environment ?? defaults.environment,
    enabledSources,
  }
  const configurationSource = config.enabledSources
    ? 'runtime' as const
    : environmentOverridesSources
      ? 'environment' as const
      : persisted
        ? 'file' as const
        : 'default' as const
  return {
    settings,
    configurationPath,
    configurationSource,
    editable: resolved.editable,
  }
}

const applyCapturePolicy: Plugin.Function<CapturePolicyPluginConfig> = (
  ctx: AgentLensContext,
  config: CapturePolicyPluginConfig = {},
) => {
  const resolved = resolveCapturePolicyPluginState(config)
  const { settings, configurationPath, configurationSource } = resolved
  ctx.provide('capturePolicy', new DefaultCapturePolicyService(settings, {
    source: configurationSource,
    editable: !config.enabledSources && !environmentOverridesSources,
    configurationPath,
    configuredEnabledSources: enabledSources,
    writeEnabledSources: async next => {
      await writeCapturePolicyConfiguration(configurationPath, next)
    },
  }))
}

/**
 * First-party mandatory runtime privacy and collection boundary.
 *
 * Source authorization is resolved from the AgentLens user configuration.
 * AGENT_LENS_ENABLED_SOURCES remains a compatibility override with higher
 * priority. Without explicit user or environment configuration, all current
 * first-party local agent sources are enabled; content still follows the
 * independent prompt/tool/config privacy modes and can be narrowed manually.
 */
export const capturePolicyPlugin = applyCapturePolicy
