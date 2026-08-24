import type { CapturePolicyMode, CapturePolicySettings } from '@agent-lens/core'
import type { Plugin } from '@deepseek-ai/cordis'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'
import { DefaultCapturePolicyService, capturePolicySettingsFromEnv } from './service'

export interface CapturePolicyPluginConfig {
  prompt?: CapturePolicyMode
  tool?: CapturePolicyMode
  config?: CapturePolicyMode
  environment?: CapturePolicyMode
  enabledSources?: readonly string[]
}

const applyCapturePolicy: Plugin.Function<CapturePolicyPluginConfig> = (
  ctx: AgentLensContext,
  config: CapturePolicyPluginConfig = {},
) => {
  const defaults = capturePolicySettingsFromEnv(process.env)
  const settings: CapturePolicySettings = {
    prompt: config.prompt ?? defaults.prompt,
    tool: config.tool ?? defaults.tool,
    config: config.config ?? defaults.config,
    environment: config.environment ?? defaults.environment,
    enabledSources: config.enabledSources ?? defaults.enabledSources,
  }
  ctx.provide('capturePolicy', new DefaultCapturePolicyService(settings))
}

/** First-party mandatory runtime privacy and collection boundary. */
export const capturePolicyPlugin = applyCapturePolicy
