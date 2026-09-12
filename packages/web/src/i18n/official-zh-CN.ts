import {
  AGENT_LENS_LOCALE_API_VERSION,
  OFFICIAL_AGENT_LENS_LOCALE,
  type LocalePackDto,
} from '@agent-lens/protocol'
import { chineseAgentsMessages } from './zh-CN/agents'
import { chineseBackupMessages } from './zh-CN/backup'
import { chineseCoreMessages } from './zh-CN/core'
import { chineseInsightsToolsMessages } from './zh-CN/insights-tools'
import { chinesePiLiveMessages } from './zh-CN/pi-live'
import { chineseReleaseErrorsMessages } from './zh-CN/release-errors'
import { chineseReviewMessages } from './zh-CN/review'
import { chineseTaskMessages } from './zh-CN/task'

export const officialChineseLocalePack: LocalePackDto = {
  localeApiVersion: AGENT_LENS_LOCALE_API_VERSION,
  locale: OFFICIAL_AGENT_LENS_LOCALE,
  name: '简体中文',
  compatibility: { agentLensMajor: 1 },
  messages: {
    ...chineseCoreMessages,
    ...chineseAgentsMessages,
    ...chineseInsightsToolsMessages,
    ...chineseTaskMessages,
    ...chinesePiLiveMessages,
    ...chineseBackupMessages,
    ...chineseReviewMessages,
    ...chineseReleaseErrorsMessages,
  },
}
