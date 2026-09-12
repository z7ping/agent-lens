import {
  BUILTIN_AGENT_LENS_LOCALES,
  isBuiltinAgentLensLocale,
  parseLocalePackDto,
  type LocaleMessagesDto,
  type LocalePackDto,
} from '@agent-lens/protocol'
import { officialEnglishLocalePack } from './official-en-US'
import { officialChineseLocalePack } from './official-zh-CN'

const registry = new Map<string, LocalePackDto>()

export function registerLocalePack(value: unknown): LocalePackDto {
  const pack = parseLocalePackDto(value)
  const existing = registry.get(pack.locale)
  if (isBuiltinAgentLensLocale(pack.locale)) {
    throw new Error(`built-in Locale Pack cannot be replaced: ${pack.locale}`)
  }
  if (existing) {
    throw new Error(`Locale Pack already registered: ${pack.locale}`)
  }
  registry.set(pack.locale, pack)
  return pack
}

export function resetLocaleRegistry(): void {
  registry.clear()
  registry.set(officialChineseLocalePack.locale, officialChineseLocalePack)
  registry.set(officialEnglishLocalePack.locale, officialEnglishLocalePack)
}

export function listLocalePacks(): LocalePackDto[] {
  const builtInOrder = new Map<string, number>(BUILTIN_AGENT_LENS_LOCALES.map((locale, index) => [locale, index]))
  return [...registry.values()].sort((a, b) => {
    const left = builtInOrder.get(a.locale)
    const right = builtInOrder.get(b.locale)
    if (left !== undefined || right !== undefined) {
      return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER)
    }
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
