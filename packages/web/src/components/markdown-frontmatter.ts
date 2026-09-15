import { parse, stringify } from 'yaml'

export interface MarkdownFrontmatterEntry {
  key: string
  value: string
}

export interface MarkdownFrontmatter {
  raw: string
  entries: MarkdownFrontmatterEntry[]
  error?: string | undefined
}

export interface MarkdownDocumentParts {
  body: string
  frontmatter: MarkdownFrontmatter | null
}

function frontmatterValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value ?? '')
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return stringify(value).trim()
}

function frontmatterEntries(value: unknown): MarkdownFrontmatterEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value === null || value === undefined ? [] : [{ key: 'value', value: frontmatterValue(value) }]
  }
  return Object.entries(value).map(([key, entry]) => ({ key, value: frontmatterValue(entry) }))
}

/**
 * Extract only a leading YAML frontmatter block. YAML syntax itself is delegated
 * to the mature `yaml` package; this helper only owns the Markdown envelope.
 */
export function splitMarkdownFrontmatter(text: string): MarkdownDocumentParts {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  const opening = source.match(/^---[ \t]*\r?\n/)
  if (!opening) return { body: text, frontmatter: null }

  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm
  closing.lastIndex = opening[0].length
  const match = closing.exec(source)
  if (!match) return { body: text, frontmatter: null }

  const raw = source.slice(opening[0].length, match.index).replace(/\r?\n$/, '')
  const body = source.slice(match.index + match[0].length)

  try {
    const value = parse(raw)
    return {
      body,
      frontmatter: {
        raw,
        entries: frontmatterEntries(value),
      },
    }
  } catch (reason) {
    return {
      body,
      frontmatter: {
        raw,
        entries: [],
        error: reason instanceof Error ? reason.message : String(reason),
      },
    }
  }
}
