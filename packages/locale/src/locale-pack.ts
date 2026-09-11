export const AGENT_LENS_LOCALE_VERSION = 1 as const
export const AGENT_LENS_BASE_LOCALE = 'zh-CN' as const

export const AGENT_LENS_LOCALE_NAMESPACES = [
  'common',
  'shell',
  'task',
  'review',
  'insights',
  'agents',
  'assets',
  'backup',
  'tools',
  'piLive',
  'settings',
  'errors',
  'locale',
] as const

export type AgentLensLocaleNamespace = typeof AGENT_LENS_LOCALE_NAMESPACES[number]
export type LocaleMessages = Readonly<Record<string, string>>

export interface AgentLensLocalePack {
  locale: string
  name: string
  agentLensLocaleVersion: typeof AGENT_LENS_LOCALE_VERSION
  messages: LocaleMessages
}

export class LocalePackValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalePackValidationError'
  }
}

const namespaces = new Set<string>(AGENT_LENS_LOCALE_NAMESPACES)
const forbiddenSegments = new Set(['__proto__', 'prototype', 'constructor'])
const keyPattern = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/

export function canonicalizeLocale(locale: string): string {
  try {
    const [canonical] = Intl.getCanonicalLocales(locale.trim())
    if (!canonical) throw new Error('empty locale')
    return canonical
  } catch {
    throw new LocalePackValidationError(`非法 locale：${locale}`)
  }
}

export function localeMessageNamespace(key: string): string {
  return key.split('.', 1)[0] ?? ''
}

export function validateLocaleMessageKey(key: string): void {
  if (!keyPattern.test(key)) {
    throw new LocalePackValidationError(`非法 i18n key：${key}`)
  }
  const segments = key.split('.')
  if (segments.some(segment => forbiddenSegments.has(segment))) {
    throw new LocalePackValidationError(`i18n key 包含保留字段：${key}`)
  }
  if (!namespaces.has(segments[0] ?? '')) {
    throw new LocalePackValidationError(`未知 i18n namespace：${segments[0] ?? ''}`)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalePackValidationError('Locale Pack 必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}

export function validateLocalePack(
  value: unknown,
  options: { allowBaseLocale?: boolean } = {},
): AgentLensLocalePack {
  const input = asRecord(value)
  if (input.agentLensLocaleVersion !== AGENT_LENS_LOCALE_VERSION) {
    throw new LocalePackValidationError(
      `不兼容的 Locale Contract：${String(input.agentLensLocaleVersion)}，当前要求 ${AGENT_LENS_LOCALE_VERSION}`,
    )
  }
  if (typeof input.locale !== 'string' || !input.locale.trim()) {
    throw new LocalePackValidationError('Locale Pack 缺少 locale')
  }
  const locale = canonicalizeLocale(input.locale)
  if (!options.allowBaseLocale && locale === AGENT_LENS_BASE_LOCALE) {
    throw new LocalePackValidationError('社区 Locale Pack 不允许覆盖官方 zh-CN 基线')
  }
  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw new LocalePackValidationError('Locale Pack 缺少名称')
  }

  const sourceMessages = asRecord(input.messages)
  const messages: Record<string, string> = Object.create(null)
  for (const [key, message] of Object.entries(sourceMessages)) {
    validateLocaleMessageKey(key)
    if (typeof message !== 'string' || !message.trim()) {
      throw new LocalePackValidationError(`翻译必须是非空字符串：${key}`)
    }
    messages[key] = message
  }
  if (!Object.keys(messages).length) {
    throw new LocalePackValidationError('Locale Pack 至少需要一个翻译 key')
  }

  return Object.freeze({
    locale,
    name: input.name.trim(),
    agentLensLocaleVersion: AGENT_LENS_LOCALE_VERSION,
    messages: Object.freeze(messages),
  })
}

export function isLocalePack(value: unknown): value is AgentLensLocalePack {
  try {
    validateLocalePack(value)
    return true
  } catch {
    return false
  }
}
