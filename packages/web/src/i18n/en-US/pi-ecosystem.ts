import type { LocaleMessagesDto } from '@agent-lens/protocol'

export const englishPiEcosystemMessages: LocaleMessagesDto = {
  piEcosystem: {
    title: 'Ecosystem Discovery',
    searchPlaceholder: 'Search Pi Packages',
    search: 'Search',
    type: {
      all: 'All types',
      extension: 'Extension',
      skill: 'Skill',
      prompt: 'Prompt template',
      theme: 'Theme',
    },
    installed: 'Installed',
    notInstalled: 'Not installed',
    version: 'Latest version',
    localVersion: 'Local version',
    resourceTypes: 'Resource types',
    typeUnknown: 'Not declared',
    localAssets: 'Local assets',
    localAssetCount: '{{count}} items',
    empty: 'No matching Pi Packages found',
    stale: 'Showing the last successful result',
    copyInstall: 'Copy install command',
    copied: 'Copied',
    officialDetail: 'Official details',
    loadFailed: 'Failed to load ecosystem data',
  },
}
