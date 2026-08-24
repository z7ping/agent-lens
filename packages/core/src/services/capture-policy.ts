import type { DiscoveredAsset } from '../contracts/source'
import type { NormalizedSourceOutput, SourceRecord } from '../domain/observation'

export type CapturePolicyMode = 'off' | 'redacted' | 'full'
export type CapturePolicyScope = 'prompt' | 'tool' | 'config' | 'environment'

export interface CapturePolicySettings {
  prompt: CapturePolicyMode
  tool: CapturePolicyMode
  config: CapturePolicyMode
  environment: CapturePolicyMode
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
 * Persistence-boundary privacy contract.
 *
 * Source implementations may perform source-specific defensive cleanup, but all
 * official persistence must still pass through this service so privacy behavior
 * cannot drift between Sources.
 */
export interface CapturePolicyService {
  readonly settings: Readonly<CapturePolicySettings>
  modeFor(scope: CapturePolicyScope): CapturePolicyMode
  isEnabled(scope: CapturePolicyScope): boolean
  capture<T>(scope: CapturePolicyScope, value: T, options?: CaptureValueOptions): CaptureValueResult<T>
  sanitizeSourceRecord(record: SourceRecord, normalized?: NormalizedSourceOutput): SourceRecord
  sanitizeNormalizedOutput(normalized: NormalizedSourceOutput): NormalizedSourceOutput
  sanitizeDiscoveredAsset(asset: DiscoveredAsset): DiscoveredAsset | null
}
