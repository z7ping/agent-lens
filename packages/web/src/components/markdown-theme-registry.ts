import { useSyncExternalStore } from 'react'
import type { CustomMarkdownThemeId } from './markdown-theme'

const STORAGE_KEY = 'agent-lens.markdown-themes.v1'
const CHANGE_EVENT = 'agent-lens:markdown-themes-changed'
const MAX_THEME_BYTES = 256 * 1024
const MAX_CUSTOM_THEMES = 20

export type MarkdownThemeImportErrorCode = 'file-type' | 'file-size' | 'unsupported-css' | 'limit' | 'storage'

export class MarkdownThemeImportError extends Error {
  constructor(public readonly code: MarkdownThemeImportErrorCode) {
    super(code)
  }
}

export interface CustomMarkdownTheme {
  id: CustomMarkdownThemeId
  name: string
  sourceName: string
  css: string
  importedAt: string
}

let snapshotCache: CustomMarkdownTheme[] | null = null

function safeSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\.css$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || `theme-${Date.now().toString(36)}`
}

function parseThemes(raw: string | null): CustomMarkdownTheme[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is CustomMarkdownTheme => {
      if (!item || typeof item !== 'object') return false
      const theme = item as Partial<CustomMarkdownTheme>
      return typeof theme.id === 'string'
        && /^custom:[a-z0-9][a-z0-9-]{0,63}$/.test(theme.id)
        && typeof theme.name === 'string'
        && typeof theme.sourceName === 'string'
        && typeof theme.css === 'string'
        && typeof theme.importedAt === 'string'
    })
  } catch {
    return []
  }
}

export function readCustomMarkdownThemes(): CustomMarkdownTheme[] {
  try { return parseThemes(localStorage.getItem(STORAGE_KEY)) } catch { return [] }
}

function getSnapshot(): CustomMarkdownTheme[] {
  snapshotCache ??= readCustomMarkdownThemes()
  return snapshotCache
}

function announceChange(themes: CustomMarkdownTheme[]) {
  snapshotCache = themes
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function persist(themes: CustomMarkdownTheme[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(themes))
    announceChange(themes)
  } catch {
    throw new MarkdownThemeImportError('storage')
  }
}

export function subscribeCustomMarkdownThemes(listener: () => void): () => void {
  const onChange = () => listener()
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return
    snapshotCache = parseThemes(event.newValue)
    listener()
  }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function useCustomMarkdownThemes(): CustomMarkdownTheme[] {
  return useSyncExternalStore(subscribeCustomMarkdownThemes, getSnapshot, getSnapshot)
}

function validateCss(css: string) {
  if (new Blob([css]).size > MAX_THEME_BYTES) throw new MarkdownThemeImportError('file-size')
  if (/@(?:import|font-face|keyframes|namespace|page|property|scope)\b|url\s*\(/i.test(css)) {
    throw new MarkdownThemeImportError('unsupported-css')
  }

  let depth = 0
  let quote = ''
  let inComment = false
  for (let index = 0; index < css.length; index += 1) {
    const current = css[index]!
    const next = css[index + 1]
    if (inComment) {
      if (current === '*' && next === '/') { inComment = false; index += 1 }
      continue
    }
    if (!quote && current === '/' && next === '*') { inComment = true; index += 1; continue }
    if (quote) {
      if (current === '\\') { index += 1; continue }
      if (current === quote) quote = ''
      continue
    }
    if (current === '"' || current === "'") { quote = current; continue }
    if (current === '{') depth += 1
    if (current === '}') depth -= 1
    if (depth < 0) throw new MarkdownThemeImportError('unsupported-css')
  }
  if (depth !== 0 || quote || inComment) throw new MarkdownThemeImportError('unsupported-css')
}

export async function importCustomMarkdownTheme(file: File): Promise<CustomMarkdownTheme> {
  if (!/\.css$/i.test(file.name)) throw new MarkdownThemeImportError('file-type')
  if (file.size > MAX_THEME_BYTES) throw new MarkdownThemeImportError('file-size')
  const css = await file.text()
  validateCss(css)

  const themes = readCustomMarkdownThemes()
  const existing = themes.find(theme => theme.sourceName.toLowerCase() === file.name.toLowerCase())
  if (!existing && themes.length >= MAX_CUSTOM_THEMES) throw new MarkdownThemeImportError('limit')
  const baseId = `custom:${safeSlug(file.name)}` as CustomMarkdownThemeId
  let candidateId = baseId
  let suffix = 2
  while (!existing && themes.some(theme => theme.id === candidateId)) {
    candidateId = `${baseId.slice(0, 57)}-${suffix}` as CustomMarkdownThemeId
    suffix += 1
  }
  const id = existing?.id ?? candidateId
  const theme: CustomMarkdownTheme = {
    id,
    name: file.name.replace(/\.css$/i, ''),
    sourceName: file.name,
    css,
    importedAt: new Date().toISOString(),
  }
  persist(existing ? themes.map(item => item.id === existing.id ? theme : item) : [...themes, theme])
  return theme
}

export function removeCustomMarkdownTheme(id: CustomMarkdownThemeId): void {
  persist(readCustomMarkdownThemes().filter(theme => theme.id !== id))
}

export function scopedCustomMarkdownCss(theme: CustomMarkdownTheme): string {
  const normalized = theme.css
    .replace(/(^|[,{]\s*)(?::root|html|body|#write)(?=\s*[,>{.:#\[])/gim, '$1:scope')
  return `@scope (.markdown[data-markdown-theme="${theme.id}"]) {\n${normalized}\n}`
}
