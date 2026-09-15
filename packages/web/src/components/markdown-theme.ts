export const MARKDOWN_THEME_IDS = ['next-helvetica', 'agent-lens'] as const

export type MarkdownThemeId = typeof MARKDOWN_THEME_IDS[number]

export const DEFAULT_MARKDOWN_THEME: MarkdownThemeId = 'next-helvetica'

export function isMarkdownThemeId(value: unknown): value is MarkdownThemeId {
  return typeof value === 'string' && MARKDOWN_THEME_IDS.some(theme => theme === value)
}
