import type { DiscoveredAsset } from '../contracts/source'
import type { NormalizedSourceOutput, SourceRecord } from '../domain/observation'

export type CapturePolicyMode = 'off' | 'redacted' | 'full'
export type CapturePolicyScope = 'prompt' | 'tool' | 'config' | 'environment'

export interface CapturePolicySettings {
  prompt: CapturePolicyMode
  tool: CapturePolicyMode
  config: CapturePolicyMode
  environment: CapturePolicyMode
  enabledSources: readonly string[]
}

export interface CaptureValueOptions {
  maxText?: number
}

export interface CaptureValueResult<T = unknown> {
  value: T | null
  mode: CapturePolicyMode
  redactionApplied: boolean
}

/**
 * Capture policy contract shared by the runtime and Source runners.
 *
 * Source implementations may perform source-specific defensive cleanup, but all
 * official persistence must still pass through this service so privacy behavior
 * cannot drift between Sources. Source activation is checked before detection or
 * ingestion, keeping disabled Sources outside the collection pipeline entirely.
 */
export interface CapturePolicyService {
  readonly settings: Readonly<CapturePolicySettings>
  modeFor(scope: CapturePolicyScope): CapturePolicyMode
  isEnabled(scope: CapturePolicyScope): boolean
  isSourceEnabled(sourceId: string): boolean
  capture<T>(scope: CapturePolicyScope, value: T, options?: CaptureValueOptions): CaptureValueResult<T>
  sanitizeSourceRecord(record: SourceRecord, normalized?: NormalizedSourceOutput): SourceRecord
  sanitizeNormalizedOutput(normalized: NormalizedSourceOutput): NormalizedSourceOutput
  sanitizeDiscoveredAsset(asset: DiscoveredAsset): DiscoveredAsset | null
}
