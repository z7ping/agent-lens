import { createInstance, type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  AGENT_LENS_BASE_LOCALE,
  validateLocalePack,
  type AgentLensLocalePack,
} from '@agent-lens/locale'
import type { LocalePackFailureDto, LocalePackListResponseDto } from '@agent-lens/protocol'
import { zhCNMessages } from './zh-CN'

export interface RegisteredLocale {
  locale: string
  name: string
  official: boolean
}

export class LocaleRegistry {
  private readonly locales = new Map<string, RegisteredLocale>()
  private readonly failures: LocalePackFailureDto[] = []
  private initialized = false

  constructor(readonly i18n: i18n) {
    this.locales.set(AGENT_LENS_BASE_LOCALE, {
      locale: AGENT_LENS_BASE_LOCALE,
      name: '简体中文',
      official: true,
    })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.i18n
      .use(initReactI18next)
      .init({
        lng: AGENT_LENS_BASE_LOCALE,
        fallbackLng: AGENT_LENS_BASE_LOCALE,
        supportedLngs: false,
        load: 'currentOnly',
        resources: {
          [AGENT_LENS_BASE_LOCALE]: {
            translation: zhCNMessages,
          },
        },
        keySeparator: false,
        nsSeparator: false,
        returnEmptyString: false,
        interpolation: { escapeValue: false },
      })
    this.initialized = true
  }

  register(pack: AgentLensLocalePack | unknown): RegisteredLocale {
    const validated = validateLocalePack(pack)
    this.i18n.addResourceBundle(
      validated.locale,
      'translation',
      validated.messages,
      true,
      true,
    )
    const registered = {
      locale: validated.locale,
      name: validated.name,
      official: false,
    }
    this.locales.set(validated.locale, registered)
    return registered
  }

  registerResponse(response: LocalePackListResponseDto): void {
    for (const item of response.items) {
      try {
        this.register(item)
      } catch (error) {
        this.failures.push({
          fileName: item.locale,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.failures.push(...response.failures)
  }

  list(): RegisteredLocale[] {
    return [...this.locales.values()]
      .sort((a, b) => Number(b.official) - Number(a.official) || a.name.localeCompare(b.name))
  }

  listFailures(): readonly LocalePackFailureDto[] {
    return this.failures
  }

  has(locale: string): boolean {
    return this.locales.has(locale)
  }

  async change(locale: string): Promise<string> {
    const target = this.has(locale) ? locale : AGENT_LENS_BASE_LOCALE
    await this.i18n.changeLanguage(target)
    if (typeof document !== 'undefined') document.documentElement.lang = target
    return target
  }
}

export function createLocaleRegistry(): LocaleRegistry {
  return new LocaleRegistry(createInstance())
}

export const localeRegistry = createLocaleRegistry()
export const i18n = localeRegistry.i18n
