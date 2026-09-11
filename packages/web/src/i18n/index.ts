import { AGENT_LENS_BASE_LOCALE } from '@agent-lens/locale'
import type { LocalePackListResponseDto } from '@agent-lens/protocol'
import { AgentLensApi } from '../client/api'
import { readLocale, writeLocale } from '../client/preferences'
import { localeRegistry } from './registry'

export { i18n, localeRegistry } from './registry'
export type { RegisteredLocale } from './registry'

export async function initializeLocaleRuntime(
  load: () => Promise<LocalePackListResponseDto> = () => new AgentLensApi().locales(),
): Promise<void> {
  await localeRegistry.initialize()
  try {
    localeRegistry.registerResponse(await load())
  } catch {
    // Locale discovery is optional. The official Chinese baseline is always available.
  }
  const preferred = readLocale()
  const active = await localeRegistry.change(
    preferred && localeRegistry.has(preferred) ? preferred : AGENT_LENS_BASE_LOCALE,
  )
  writeLocale(active)
}

export async function changeLocale(locale: string): Promise<void> {
  const active = await localeRegistry.change(locale)
  writeLocale(active)
}
