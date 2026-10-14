import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { codeLanguageFromContent, normalizedCodeLanguage } from '../components/code-language'
import { MarkdownContent } from '../components/MarkdownContent'

export type ToolOutputFormat = 'json' | 'markdown' | null

/** Do not guess Markdown from arbitrary logs or pipe-separated diagnostic lines. */
export function detectToolOutputFormat(text: string): ToolOutputFormat {
  const value = text.trim()
  if (!value) return null
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { JSON.parse(value); return 'json' } catch { /* Not JSON. */ }
  }
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const tableSeparator = /^\|?\s*:?-{1,}:?\s*\|\s*:?-{1,}:?(?:\s*\|\s*:?-{1,}:?)*\s*\|?$/
  if (lines.length >= 3 && lines[0]?.includes('|') && tableSeparator.test(lines[1] ?? '')
    && lines[2]?.includes('|')) return 'markdown'
  // A genuine fenced code block carries its own language; MarkdownContent
  // hands that language to the shared Prism renderer, without guessing logs.
  const fence = value.match(/^\x60{3}([a-z0-9+-]+)\s*\n[\s\S]*\n\x60{3}\s*$/i)
  if (fence && (['markdown', 'md'].includes(fence[1]!.toLowerCase()) || normalizedCodeLanguage(fence[1]))) return 'markdown'
  return null
}

/** Source is preserved exactly; structured rendering is an explicit opt-in. */
export function ToolOutputContent({ text, streaming = false, highlight = true }: { text: string; streaming?: boolean; highlight?: boolean }) {
  const { t } = useTranslation('task')
  const [formatted, setFormatted] = useState(false)
  const format = streaming ? null : detectToolOutputFormat(text)
  const view = formatted && format ? 'formatted' : 'original'
  let pretty = text
  if (view === 'formatted' && format === 'json') {
    try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch { pretty = text }
  }
  return <div className="task-tool-output-content" data-view={view}>
    {format && <div className="task-tool-output-format-actions">
      <button type="button" aria-pressed={view === 'original'} onClick={() => setFormatted(false)}>{t('toolOutput.original')}</button>
      <button type="button" aria-pressed={view === 'formatted'} onClick={() => setFormatted(true)}>{t('toolOutput.formatted')}</button>
    </div>}
    {view === 'formatted' && format === 'markdown'
      ? <div className="task-tool-formatted-output"><MarkdownContent text={text}/></div>
      : <div className="task-tool-original-output"><CopyableCodeBlock copyValue={text} language={highlight && !streaming ? codeLanguageFromContent(pretty) : undefined}>{pretty}</CopyableCodeBlock></div>}
  </div>
}
