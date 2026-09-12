import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissingPathError } from '@agent-lens/source-support'
import { parse } from 'smol-toml'

export type CodexTomlConfig = Record<string, unknown>

export async function readCodexConfig(
  configRoot: string,
): Promise<CodexTomlConfig | null> {
  let content: string
  try {
    content = await readFile(join(configRoot, 'config.toml'), 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return {}
    throw error
  }

  try {
    const parsed = parse(content)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as CodexTomlConfig
      : {}
  } catch {
    // A malformed Codex config is not an invitation for AgentLens to maintain
    // a second, more permissive parser. Callers keep unrelated file assets,
    // while config-derived facts remain unavailable.
    return null
  }
}

export function codexStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined
  return value.map(item => item.trim())
}

export function codexTable(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
