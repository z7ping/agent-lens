import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'

export type TaskMessageRole = 'user' | 'assistant'

export interface TaskMessageProps {
  role: TaskMessageRole
  text: string
  author?: string
  time?: string
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
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [expanded, setExpanded] = useState(false)
  const [canCollapse, setCanCollapse] = useState(false)
  const [collapsedHeight, setCollapsedHeight] = useState<number>()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const user = role === 'user'

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
    setExpanded(false)
    const element = surfaceRef.current
    if (!element) return
    const frame = window.requestAnimationFrame(measure)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [measure, text, view])

  return <div className={`chat-row ${user ? 'chat-row-user' : 'chat-row-agent'} task-message-row ${className}`.trim()} data-task-message-role={role}>
    <div className={`chat-avatar ${user ? 'chat-avatar-user' : 'chat-avatar-agent'}`}>{user ? '你' : '智'}</div>
    <div className={`chat-bubble ${user ? 'chat-bubble-user' : 'chat-bubble-agent'} task-message-bubble`}>
      <div className="chat-meta task-message-meta"><span>{author}</span>{meta}{time && <time>{time}</time>}</div>
      <div className="markdown-message task-message-content" data-view={view}>
        <div
          ref={surfaceRef}
          className={`markdown-surface ${canCollapse && !expanded ? 'is-collapsed' : ''}`}
          style={canCollapse && !expanded && collapsedHeight ? { maxHeight: `${collapsedHeight}px` } : undefined}
        >
          {view === 'rendered' ? <div className="markdown"><ReactMarkdown>{text}</ReactMarkdown></div> : <pre className="markdown-source">{text}</pre>}
          {canCollapse && !expanded && <span className="markdown-fade" aria-hidden="true"/>}
        </div>
        <div className="markdown-message-actions">
          {canCollapse && <button type="button" onClick={() => setExpanded(value => !value)}>{expanded ? '收起到 5 行' : '展开全文'}</button>}
          <button type="button" onClick={() => setView(value => value === 'rendered' ? 'source' : 'rendered')}>{view === 'rendered' ? '查看源码' : '返回渲染'}</button>
        </div>
      </div>
      {actions && <div className="chat-actions task-message-actions">{actions}</div>}
    </div>
  </div>
}
