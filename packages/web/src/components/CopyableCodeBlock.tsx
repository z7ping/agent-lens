import { isValidElement, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { copyText } from '../client/clipboard'
import { UiIcon } from './UiIcon'

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
      <UiIcon name={state === 'copied' ? 'check' : 'copy'} size={16}/>
      <span>{label}</span>
    </button>
  </div>
}
