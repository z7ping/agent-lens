import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError } from '@agent-lens/source-support'
import { listPiProjectCwds } from './session'

type JsonRecord = Record<string, unknown>
type ModelScope = 'user' | 'project'

interface ParsedConfig {
  path: string
  value: JsonRecord
  observedAt: string
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must contain a JSON object`)
  }
  return value as JsonRecord
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function readJsonConfig(path: string): Promise<ParsedConfig | undefined> {
  let text: string
  let observedAt: string
  try {
    const [content, meta] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    text = content
    observedAt = meta.mtime.toISOString()
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }

  const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
  return { path, value: asRecord(parsed, path), observedAt }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function modelIdentity(provider: string, modelId: string): string {
  return `${provider}/${modelId}`
}

function configEvidence(path: string, observedAt: string, capturedAt: string): EvidenceCandidate {
  return {
    captureMethod: 'static-scan',
    derivation: 'observed',
    sourceLocator: { kind: 'file', path },
    eventTime: observedAt,
    capturedAt,
    confidenceHint: 'exact',
  }
}

function configuredModelAsset(input: {
  provider: string
  modelId: string
  displayName?: string
  config: ParsedConfig
  source: string
  scope: ModelScope
  scopeRoot: string
  capturedAt: string
}): DiscoveredAsset {
  const identity = modelIdentity(input.provider, input.modelId)
  return {
    definition: {
      type: 'model',
      canonicalName: identity,
      displayName: input.displayName ?? input.modelId,
      upstreamIdentity: `pi-model:${identity}`,
    },
    binding: {
      path: input.config.path,
      source: input.source,
      scope: input.scope,
      scopeRoot: input.scopeRoot,
    },
    states: [
      {
        state: 'configured',
        value: true,
        observedAt: input.config.observedAt,
        evidenceCandidates: [configEvidence(input.config.path, input.config.observedAt, input.capturedAt)],
      },
      {
        // Static configuration proves declaration, not authentication or runtime availability.
        state: 'discoverable',
        value: 'unknown',
        observedAt: input.capturedAt,
      },
    ],
  }
}

function defaultModelFromSettings(input: {
  config: ParsedConfig
  scope: ModelScope
  scopeRoot: string
  capturedAt: string
}): DiscoveredAsset | undefined {
  const provider = optionalString(input.config.value, 'defaultProvider')
  const modelId = optionalString(input.config.value, 'defaultModel')
  if (!provider || !modelId) return undefined
  const scopeSuffix = input.scope === 'project'
    ? `project:${sha256(resolve(input.scopeRoot)).slice(0, 12)}`
    : 'user'
  return configuredModelAsset({
    provider,
    modelId,
    config: input.config,
    source: `pi:model:default:${scopeSuffix}`,
    scope: input.scope,
    scopeRoot: input.scopeRoot,
    capturedAt: input.capturedAt,
  })
}

function modelsFromConfig(config: ParsedConfig, agentDir: string, capturedAt: string): DiscoveredAsset[] {
  const providers = asRecord(config.value.providers, `${config.path} providers`)
  const assets: DiscoveredAsset[] = []

  for (const [provider, rawProvider] of Object.entries(providers)) {
    const providerConfig = asRecord(rawProvider, `${config.path} provider ${provider}`)
    const models = providerConfig.models
    if (models !== undefined) {
      if (!Array.isArray(models)) throw new TypeError(`${config.path} provider ${provider} models must be an array`)
      for (const rawModel of models) {
        const model = asRecord(rawModel, `${config.path} provider ${provider} model`)
        const modelId = optionalString(model, 'id')
        if (!modelId) throw new TypeError(`${config.path} provider ${provider} model id must be a non-empty string`)
        assets.push(configuredModelAsset({
          provider,
          modelId,
          displayName: optionalString(model, 'name'),
          config,
          source: `pi:model:custom:${provider}`,
          scope: 'user',
          scopeRoot: agentDir,
          capturedAt,
        }))
      }
    }

    const overrides = providerConfig.modelOverrides
    if (overrides !== undefined) {
      const rows = asRecord(overrides, `${config.path} provider ${provider} modelOverrides`)
      for (const [modelId, rawOverride] of Object.entries(rows)) {
        asRecord(rawOverride, `${config.path} provider ${provider} model override ${modelId}`)
        if (!modelId.trim()) continue
        assets.push(configuredModelAsset({
          provider,
          modelId: modelId.trim(),
          config,
          source: `pi:model:override:${provider}`,
          scope: 'user',
          scopeRoot: agentDir,
          capturedAt,
        }))
      }
    }
  }

  return assets
}

/**
 * Read only the non-secret parts of Pi model configuration.
 * API keys, headers and command-backed secret values are never copied into AgentLens assets.
 */
export async function resolvePiModelConfigAssets(
  ctx: SourceExecutionContext,
): Promise<DiscoveredAsset[]> {
  const agentDir = ctx.installation.configRoot
  if (!agentDir || ctx.abortSignal.aborted) return []

  const capturedAt = new Date().toISOString()
  const assets: DiscoveredAsset[] = []

  const userSettings = await readJsonConfig(join(agentDir, 'settings.json'))
  if (userSettings) {
    const defaultModel = defaultModelFromSettings({
      config: userSettings,
      scope: 'user',
      scopeRoot: agentDir,
      capturedAt,
    })
    if (defaultModel) assets.push(defaultModel)
  }

  const modelsConfig = await readJsonConfig(join(agentDir, 'models.json'))
  if (modelsConfig) assets.push(...modelsFromConfig(modelsConfig, agentDir, capturedAt))

  for (const cwd of await listPiProjectCwds(ctx)) {
    if (ctx.abortSignal.aborted) break
    const settings = await readJsonConfig(join(cwd, '.pi', 'settings.json'))
    if (!settings) continue
    const defaultModel = defaultModelFromSettings({
      config: settings,
      scope: 'project',
      scopeRoot: cwd,
      capturedAt,
    })
    if (defaultModel) assets.push(defaultModel)
  }

  const dedup = new Map<string, DiscoveredAsset>()
  for (const asset of assets) {
    const binding = asset.binding
    const key = [
      asset.definition.upstreamIdentity ?? asset.definition.canonicalName,
      binding?.path ?? '',
      binding?.source ?? '',
      binding?.scopeRoot ?? '',
    ].join('\u0000')
    dedup.set(key, asset)
  }
  return [...dedup.values()]
}

export const piModelConfigInternals = {
  readJsonConfig,
  defaultModelFromSettings,
  modelsFromConfig,
}
