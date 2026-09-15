export const BUILTIN_MARKDOWN_THEME_IDS = ['next-helvetica', 'agent-lens'] as const

export type BuiltinMarkdownThemeId = typeof BUILTIN_MARKDOWN_THEME_IDS[number]
export type CustomMarkdownThemeId = `custom:${string}`
export type MarkdownThemeId = BuiltinMarkdownThemeId | CustomMarkdownThemeId

export const DEFAULT_MARKDOWN_THEME: MarkdownThemeId = 'next-helvetica'

export function isMarkdownThemeId(value: unknown): value is MarkdownThemeId {
  return typeof value === 'string' && (
    BUILTIN_MARKDOWN_THEME_IDS.some(theme => theme === value)
    || /^custom:[a-z0-9][a-z0-9-]{0,63}$/.test(value)
  )
}
