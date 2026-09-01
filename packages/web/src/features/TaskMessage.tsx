import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'

export type TaskMessageRole = 'user' | 'assistant'

export interface TaskMessageProps {
  role: TaskMessageRole
  text: string
  author?: string
  time?: string | undefined
  meta?: ReactNode
  actions?: ReactNode
  collapsible?: boolean
  className?: string
}

/**
 * 历史 Review 与已完成 Live 消息共用的稳定消息表现。
 * Streaming Tail 不使用本组件，避免生成过程中切换源码导致内容状态混乱。
 */
export function TaskMessage({
  role,
  text,
  author = role === 'user' ? '你' : '智能体',
  time,
  meta,
  actions,
  collapsible = true,
  className = '',
}: TaskMessageProps) {
  const user = role === 'user'
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [expanded, setExpanded] = useState(() => !user)
  const [canCollapse, setCanCollapse] = useState(false)
  const [collapsedHeight, setCollapsedHeight] = useState<number>()
  const surfaceRef = useRef<HTMLDivElement>(null)

  const measure = useCallback(() => {
    const element = surfaceRef.current
    if (!element || !collapsible) {
      setCanCollapse(false)
      return
    }
    const style = window.getComputedStyle(element)
    const fontSize = Number.parseFloat(style.fontSize) || 14
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.65
    const limit = Math.ceil(lineHeight * 5 + 2)
    setCollapsedHeight(limit)
    setCanCollapse(element.scrollHeight > limit + 2)
  }, [collapsible])

  useLayoutEffect(() => {
    // Agent 正文默认完整展开；用户长消息继续沿用紧凑折叠策略。
    setExpanded(!user)
    const element = surfaceRef.current
    if (!element) return
    const frame = window.requestAnimationFrame(measure)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [measure, text, user, view])

  const roleClass = user ? 'task-message-user' : 'task-message-assistant'
  const bubbleClass = user ? 'task-message-bubble-user' : 'task-message-bubble-assistant'

  return <div className={`task-message-row ${roleClass} ${className}`.trim()} data-task-message-role={role}>
    <div className={`task-message-bubble ${bubbleClass}`}>
      <div className="task-message-meta"><b>{author}</b>{meta}{time && <time>{time}</time>}</div>
      <div className="markdown-message task-message-content" data-view={view}>
        <div
          ref={surfaceRef}
          className={`markdown-surface ${canCollapse && !expanded ? 'is-collapsed' : ''}`}
          style={canCollapse && !expanded && collapsedHeight ? { maxHeight: `${collapsedHeight}px` } : undefined}
        >
          {view === 'rendered' ? <div className="markdown"><ReactMarkdown>{text}</ReactMarkdown></div> : <pre className="markdown-source">{text}</pre>}
          {canCollapse && !expanded && <span className="markdown-fade" aria-hidden="true"/>}
        </div>
        {(canCollapse || !user) && <div className="markdown-message-actions">
          {canCollapse && <button type="button" onClick={() => setExpanded(value => !value)}>{expanded ? '收起到 5 行' : '展开全文'}</button>}
          {!user && <button type="button" title={view === 'rendered' ? '查看 Markdown 源码' : '返回渲染结果'} onClick={() => setView(value => value === 'rendered' ? 'source' : 'rendered')}>
            {view === 'rendered' ? <span>源码</span> : <span>渲染</span>}
          </button>}
        </div>}
      </div>
      {actions && <div className="task-message-actions">{actions}</div>}
    </div>
  </div>
}
