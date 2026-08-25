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

const FIRST_PARTY_SOURCE_IDS = [
  'codex',
  'claude-code',
  'pi',
  'hermes',
  'opencode',
  'dsh',
] as const

const applyCapturePolicy: Plugin.Function<CapturePolicyPluginConfig> = (
  ctx: AgentLensContext,
  config: CapturePolicyPluginConfig = {},
) => {
  const defaults = capturePolicySettingsFromEnv(process.env)
  const enabledSources = config.enabledSources
    ?? (process.env.AGENT_LENS_ENABLED_SOURCES === undefined
      ? FIRST_PARTY_SOURCE_IDS
      : defaults.enabledSources)
  const settings: CapturePolicySettings = {
    prompt: config.prompt ?? defaults.prompt,
    tool: config.tool ?? defaults.tool,
    config: config.config ?? defaults.config,
    environment: config.environment ?? defaults.environment,
    enabledSources,
  }
  ctx.provide('capturePolicy', new DefaultCapturePolicyService(settings))
}

/**
 * First-party mandatory runtime privacy and collection boundary.
 *
 * The runtime allows all shipped first-party Sources by default, while each
 * Source still has to be detected locally before collection starts. Users can
 * explicitly narrow or disable the allowlist through AGENT_LENS_ENABLED_SOURCES.
 */
export const capturePolicyPlugin = applyCapturePolicy
