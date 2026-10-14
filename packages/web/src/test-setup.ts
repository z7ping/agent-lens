import { OFFICIAL_AGENT_LENS_LOCALE } from '@agent-lens/protocol'
import { initializeI18n, setLocale } from './i18n/runtime'

await initializeI18n()
// Node has no navigator.language; keep existing Chinese UI assertions deterministic.
await setLocale(OFFICIAL_AGENT_LENS_LOCALE)
