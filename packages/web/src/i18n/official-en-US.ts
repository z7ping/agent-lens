import {
  AGENT_LENS_LOCALE_API_VERSION,
  BUILTIN_AGENT_LENS_ENGLISH_LOCALE,
  type LocalePackDto,
} from '@agent-lens/protocol'
import { englishAgentsMessages } from './en-US/agents'
import { englishBackupMessages } from './en-US/backup'
import { englishCoreMessages } from './en-US/core'
import { englishInsightsToolsMessages } from './en-US/insights-tools'
import { englishPiLiveMessages } from './en-US/pi-live'
import { englishReleaseErrorsMessages } from './en-US/release-errors'
import { englishReviewMessages } from './en-US/review'
import { englishTaskMessages } from './en-US/task'

export const officialEnglishLocalePack: LocalePackDto = {
  localeApiVersion: AGENT_LENS_LOCALE_API_VERSION,
  locale: BUILTIN_AGENT_LENS_ENGLISH_LOCALE,
  name: 'English',
  compatibility: { agentLensMajor: 1 },
  messages: {
    ...englishCoreMessages,
    ...englishAgentsMessages,
    ...englishInsightsToolsMessages,
    ...englishTaskMessages,
    ...englishPiLiveMessages,
    ...englishBackupMessages,
    ...englishReviewMessages,
    ...englishReleaseErrorsMessages,
  },
}
