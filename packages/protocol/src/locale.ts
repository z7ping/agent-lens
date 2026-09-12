import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export const AGENT_LENS_LOCALE_API_VERSION = 1 as const
export const OFFICIAL_AGENT_LENS_LOCALE = 'zh-CN' as const

export type LocaleMessageValueDto = string | { [key: string]: LocaleMessageValueDto }
export type LocaleMessagesDto = Record<string, LocaleMessageValueDto>

export interface LocalePackDto {
  localeApiVersion: typeof AGENT_LENS_LOCALE_API_VERSION
  locale: string
  name: string
  compatibility: {
    agentLensMajor: 1
  }
  messages: LocaleMessagesDto
}

export interface RejectedLocalePackDto {
  fileName: string
  reason: string
}

export interface LocalePackListResponseDto {
  items: LocalePackDto[]
  rejected: RejectedLocalePackDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    localeApiVersion: typeof AGENT_LENS_LOCALE_API_VERSION
    generatedAt: string
  }
}

const BLOCKED_MESSAGE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_MESSAGE_DEPTH = 12
const MAX_MESSAGE_ENTRIES = 10_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function canonicalLocale(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('locale must be a non-empty string')
  try {
    const [locale] = Intl.getCanonicalLocales(value.trim())
    if (!locale) throw new Error('invalid locale')
    return locale
  } catch {
    throw new Error('locale must be a valid BCP 47 language tag')
  }
}

function normalizeMessages(
  value: unknown,
  state: { entries: number },
  depth = 0,
): LocaleMessagesDto {
  const input = asRecord(value)
  if (!input) throw new Error('messages must be an object')
  if (depth > MAX_MESSAGE_DEPTH) throw new Error('messages exceed maximum nesting depth')

  const output: LocaleMessagesDto = {}
  for (const [key, item] of Object.entries(input)) {
    if (!key.trim()) throw new Error('message key must not be empty')
    if (BLOCKED_MESSAGE_KEYS.has(key)) throw new Error(`message key is not allowed: ${key}`)
    state.entries += 1
    if (state.entries > MAX_MESSAGE_ENTRIES) throw new Error('messages contain too many entries')

    if (typeof item === 'string') {
      output[key] = item
      continue
    }
    output[key] = normalizeMessages(item, state, depth + 1)
  }
  return output
}

export function parseLocalePackDto(value: unknown): LocalePackDto {
  const input = asRecord(value)
  if (!input) throw new Error('Locale Pack must be an object')
  if (input.localeApiVersion !== AGENT_LENS_LOCALE_API_VERSION) {
    throw new Error(`unsupported localeApiVersion: ${String(input.localeApiVersion)}`)
  }

  const compatibility = asRecord(input.compatibility)
  if (!compatibility || compatibility.agentLensMajor !== 1) {
    throw new Error('Locale Pack is not compatible with AgentLens 1.x')
  }

  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) {
    throw new Error('name must be a non-empty string up to 80 characters')
  }

  return {
    localeApiVersion: AGENT_LENS_LOCALE_API_VERSION,
    locale: canonicalLocale(input.locale),
    name: input.name.trim(),
    compatibility: { agentLensMajor: 1 },
    messages: normalizeMessages(input.messages, { entries: 0 }),
  }
}

export const localePackProtocolInternals = {
  canonicalLocale,
  normalizeMessages,
}
