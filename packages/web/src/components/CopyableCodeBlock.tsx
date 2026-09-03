import { isValidElement, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { copyText } from '../client/clipboard'

type CopyState = 'idle' | 'copied' | 'error'

export interface CopyableCodeBlockProps extends ComponentPropsWithoutRef<'pre'> {
  copyValue?: string
  containerClassName?: string
}

function textFromChildren(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(textFromChildren).join('')
  if (isValidElement<{ children?: ReactNode }>(children)) return textFromChildren(children.props.children)
  return ''
}

export function CopyableCodeBlock({ children, copyValue, containerClassName = '', ...preProps }: CopyableCodeBlockProps) {
  const [state, setState] = useState<CopyState>('idle')
  const resetTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  const copy = async () => {
    window.clearTimeout(resetTimer.current)
    try {
      await copyText(copyValue ?? textFromChildren(children))
      setState('copied')
    } catch {
      setState('error')
    }
    resetTimer.current = window.setTimeout(() => setState('idle'), 1800)
  }

  const label = state === 'copied' ? '已复制' : state === 'error' ? '复制失败' : '复制'
  return <div className={`copyable-code-block ${containerClassName}`.trim()} data-copy-state={state}>
    <pre {...preProps}>{children}</pre>
    <button type="button" className="code-block-copy" onClick={() => void copy()} aria-label={`${label}代码块`} title={label}>
      {state === 'copied'
        ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.4 2.7 2.7 6.3-6.3"/></svg>
        : <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.2" y="5.2" width="7.3" height="7.3" rx="1.2"/><path d="M10.5 5.2V4.7A1.2 1.2 0 0 0 9.3 3.5H4.7a1.2 1.2 0 0 0-1.2 1.2v4.6a1.2 1.2 0 0 0 1.2 1.2h.5"/></svg>}
      <span>{label}</span>
    </button>
  </div>
}
