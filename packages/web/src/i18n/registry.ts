import {
  OFFICIAL_AGENT_LENS_LOCALE,
  parseLocalePackDto,
  type LocaleMessagesDto,
  type LocalePackDto,
} from '@agent-lens/protocol'
import { officialChineseLocalePack } from './official-zh-CN'

const registry = new Map<string, LocalePackDto>()

export function registerLocalePack(value: unknown): LocalePackDto {
  const pack = parseLocalePackDto(value)
  const existing = registry.get(pack.locale)
  if (existing && pack.locale === OFFICIAL_AGENT_LENS_LOCALE && existing !== officialChineseLocalePack) {
    throw new Error('official zh-CN Locale Pack cannot be replaced')
  }
  if (existing && pack.locale !== OFFICIAL_AGENT_LENS_LOCALE) {
    throw new Error(`Locale Pack already registered: ${pack.locale}`)
  }
  registry.set(pack.locale, pack)
  return pack
}

export function resetLocaleRegistry(): void {
  registry.clear()
  registry.set(officialChineseLocalePack.locale, officialChineseLocalePack)
}

export function listLocalePacks(): LocalePackDto[] {
  return [...registry.values()].sort((a, b) => {
    if (a.locale === OFFICIAL_AGENT_LENS_LOCALE) return -1
    if (b.locale === OFFICIAL_AGENT_LENS_LOCALE) return 1
    return a.name.localeCompare(b.name)
  })
}

export function localePack(locale: string): LocalePackDto | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(locale)
    return canonical ? registry.get(canonical) ?? null : null
  } catch {
    return null
  }
}

export function resourceBundles(): Record<string, LocaleMessagesDto> {
  return Object.fromEntries([...registry.entries()].map(([locale, pack]) => [locale, pack.messages]))
}

resetLocaleRegistry()
