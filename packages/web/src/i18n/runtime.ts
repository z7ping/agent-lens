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
const LOCALE_DISCOVERY_TIMEOUT_MS = 5_000
let localeSelectionRevision = 0

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

async function discoverCommunityLocalePacks(preferred: string, selectionRevision: number): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOCALE_DISCOVERY_TIMEOUT_MS)
  try {
    const response = await fetch('/api/v1/locales', {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return
    const payload = await response.json() as LocalePackListResponseDto
    for (const pack of payload.items) {
      try {
        const registered = registerLocalePack(pack)
        for (const [namespace, messages] of Object.entries(registered.messages)) {
          agentLensI18n.addResourceBundle(registered.locale, namespace, messages)
        }
      } catch { /* one bad/duplicate pack must not break startup */ }
    }
    agentLensI18n.emit('loaded', {})
    // 恢复社区语言偏好，但不覆盖发现期间用户主动切换的语言。
    if (selectionRevision === localeSelectionRevision && listLocalePacks().some(pack => pack.locale === preferred)) {
      await agentLensI18n.changeLanguage(preferred)
      if (typeof document !== 'undefined') document.documentElement.lang = preferred
    }
  } catch {
    // Offline/static development still boots with the official Chinese baseline.
  } finally {
    clearTimeout(timeout)
  }
}

export async function initializeI18n(): Promise<i18n> {
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
      react: { useSuspense: false, bindI18n: 'languageChanged loaded' },
    })

  if (typeof document !== 'undefined') document.documentElement.lang = available
  // 内置语言先完成首屏启动，社区语言包随后补充到同一资源注册表。
  void discoverCommunityLocalePacks(preferred, localeSelectionRevision)
  return agentLensI18n
}

export async function setLocale(locale: string): Promise<void> {
  const pack = listLocalePacks().find(item => item.locale === locale)
  if (!pack) throw new Error(`Locale Pack is not installed: ${locale}`)
  localeSelectionRevision += 1
  await agentLensI18n.changeLanguage(pack.locale)
  writeLocalePreference(pack.locale)
  if (typeof document !== 'undefined') document.documentElement.lang = pack.locale
}
