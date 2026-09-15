import { parseLiveThinkingControlDto, type LiveThinkingControlDto } from '@agent-lens/protocol'

/**
 * Shared Live Surface gate for Runtime-owned thinking controls.
 *
 * A surface must have both the declared capability and a valid Runtime
 * description. Values remain opaque and are never normalized here.
 */
export function resolveLiveThinkingControl(
  hasCapability: boolean,
  value: unknown,
): LiveThinkingControlDto | null {
  return hasCapability ? parseLiveThinkingControlDto(value) : null
}
