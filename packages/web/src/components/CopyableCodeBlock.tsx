import { isValidElement, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Prism, { type Token as PrismToken } from 'prismjs'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-powershell'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-diff'
import { copyText } from '../client/clipboard'
import { normalizedCodeLanguage } from './code-language'
import { UiIcon } from './UiIcon'

type CopyState = 'idle' | 'copied' | 'error'

export interface CopyableCodeBlockProps extends ComponentPropsWithoutRef<'pre'> {
  copyValue?: string
  containerClassName?: string
  /** Explicit syntax evidence, e.g. a Markdown fence or a Tool's original JSON. */
  language?: string
}

function textFromChildren(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(textFromChildren).join('')
  if (isValidElement<{ children?: ReactNode }>(children)) return textFromChildren(children.props.children)
  return ''
}

/** ReactMarkdown supplies <pre><code className="language-ts">...</code></pre>. */
function fencedLanguage(children: ReactNode): string | undefined {
  if (Array.isArray(children)) return children.map(fencedLanguage).find(Boolean)
  if (isValidElement<{ className?: string; children?: ReactNode }>(children)) {
    const match = children.props.className?.match(/(?:^|\s)language-([a-z0-9+-]+)/i)
    return match ? match[1] : fencedLanguage(children.props.children)
  }
  return undefined
}

function tokenNodes(tokens: Array<string | PrismToken>, prefix: string): ReactNode[] {
  return tokens.map((token, index) => {
    if (typeof token === 'string') return token
    const kinds = [token.type, ...(Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [])]
      .map(value => value.replace(/[^a-z0-9_-]/gi, ''))
      .filter(Boolean)
    const content = typeof token.content === 'string' ? token.content
      : tokenNodes(Array.isArray(token.content) ? token.content : [token.content], `${prefix}-${index}`)
    return <span key={`${prefix}-${index}`} className={kinds.map(kind => `token-${kind}`).join(' ')}>{content}</span>
  })
}

export function CopyableCodeBlock({ children, copyValue, containerClassName = '', language, ...preProps }: CopyableCodeBlockProps) {
  const { t } = useTranslation('common')
  const [state, setState] = useState<CopyState>('idle')
  const resetTimer = useRef<number | undefined>(undefined)
  const original = copyValue ?? textFromChildren(children)
  const resolvedLanguage = normalizedCodeLanguage(language ?? fencedLanguage(children))
  // Avoid expensive repeated tokenization for large agent logs. Plain text and
  // copyability always remain available, with no arbitrary-language guessing.
  const highlighted = useMemo(() => {
    if (!resolvedLanguage || original.length > 80_000) return null
    const grammar = Prism.languages[resolvedLanguage]
    return grammar ? tokenNodes(Prism.tokenize(original, grammar), 'token') : null
  }, [original, resolvedLanguage])

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  const copy = async () => {
    window.clearTimeout(resetTimer.current)
    try {
      await copyText(original)
      setState('copied')
    } catch {
      setState('error')
    }
    resetTimer.current = window.setTimeout(() => setState('idle'), 1800)
  }

  const label = state === 'copied' ? t('codeBlock.copied') : state === 'error' ? t('codeBlock.failed') : t('codeBlock.copy')
  return <div className={`copyable-code-block ${containerClassName}`.trim()} data-copy-state={state} data-code-language={highlighted ? resolvedLanguage : undefined}>
    <pre {...preProps}>{highlighted ? <code className={`language-${resolvedLanguage}`}>{highlighted}</code> : children}</pre>
    <button type="button" className="code-block-copy" onClick={() => void copy()} aria-label={t('codeBlock.aria', { label })} title={label}>
      <UiIcon name={state === 'copied' ? 'check' : 'copy'} size={16}/>
      <span>{label}</span>
    </button>
  </div>
}
