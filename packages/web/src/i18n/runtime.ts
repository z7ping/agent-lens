import { createInstance, type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  OFFICIAL_AGENT_LENS_LOCALE,
  type LocalePackListResponseDto,
} from '@agent-lens/protocol'
import { officialChineseLocalePack } from './official-zh-CN'
import {
  listLocalePacks,
  registerLocalePack,
  resourceBundles,
} from './registry'

const LOCALE_PREFERENCE_KEY = 'agent-lens.locale.v1'

export const agentLensI18n: i18n = createInstance()

export function currentProductLocale(): string {
  return agentLensI18n.resolvedLanguage ?? agentLensI18n.language ?? OFFICIAL_AGENT_LENS_LOCALE
}

export function translateProduct(key: string, options: Record<string, unknown> = {}): string {
  if (agentLensI18n.isInitialized) return String(agentLensI18n.t(key, options))

  const separator = key.indexOf(':')
  const namespace = separator >= 0 ? key.slice(0, separator) : 'common'
  const path = (separator >= 0 ? key.slice(separator + 1) : key).split('.').filter(Boolean)
  let value: unknown = (officialChineseLocalePack.messages as Record<string, unknown>)[namespace]
  for (const part of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return key
    value = (value as Record<string, unknown>)[part]
  }
  if (typeof value !== 'string') return key
  return value.replace(/{{\s*([\w.-]+)\s*}}/g, (_match, token: string) => {
    const replacement = options[token]
    return replacement === undefined || replacement === null ? '' : String(replacement)
  })
}

export function readLocalePreference(): string {
  try {
    const stored = localStorage.getItem(LOCALE_PREFERENCE_KEY)
    return stored || OFFICIAL_AGENT_LENS_LOCALE
  } catch {
    return OFFICIAL_AGENT_LENS_LOCALE
  }
}

export function writeLocalePreference(locale: string): void {
  try { localStorage.setItem(LOCALE_PREFERENCE_KEY, locale) } catch { /* storage unavailable */ }
}

async function discoverCommunityLocalePacks(): Promise<void> {
  try {
    const response = await fetch('/api/v1/locales', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return
    const payload = await response.json() as LocalePackListResponseDto
    for (const pack of payload.items) {
      try { registerLocalePack(pack) } catch { /* one bad/duplicate pack must not break startup */ }
    }
  } catch {
    // Offline/static development still boots with the official Chinese baseline.
  }
}

export async function initializeI18n(): Promise<i18n> {
  await discoverCommunityLocalePacks()
  const resources = Object.fromEntries(
    Object.entries(resourceBundles()).map(([locale, messages]) => [locale, messages]),
  )
  const preferred = readLocalePreference()
  const available = listLocalePacks().some(pack => pack.locale === preferred)
    ? preferred
    : OFFICIAL_AGENT_LENS_LOCALE

  await agentLensI18n
    .use(initReactI18next)
    .init({
      resources,
      lng: available,
      fallbackLng: OFFICIAL_AGENT_LENS_LOCALE,
      defaultNS: 'common',
      ns: ['common', 'navigation', 'shell', 'settings', 'agents', 'insights', 'tools', 'task', 'piLive', 'backup', 'review', 'release', 'errors'],
      interpolation: { escapeValue: false },
      returnNull: false,
      react: { useSuspense: false },
    })

  document.documentElement.lang = available
  return agentLensI18n
}

export async function setLocale(locale: string): Promise<void> {
  const pack = listLocalePacks().find(item => item.locale === locale)
  if (!pack) throw new Error(`Locale Pack is not installed: ${locale}`)
  await agentLensI18n.changeLanguage(pack.locale)
  writeLocalePreference(pack.locale)
  document.documentElement.lang = pack.locale
}
