import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ReviewMessageAttachmentDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { MarkdownContent } from '../components/MarkdownContent'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'

export type TaskMessageRole = 'user' | 'assistant'

export interface TaskMessageProps {
  role: TaskMessageRole
  text: string
  attachments?: readonly ReviewMessageAttachmentDto[] | undefined
  author?: string
  time?: string | undefined
  meta?: ReactNode
  actions?: ReactNode
  collapsible?: boolean
  streaming?: boolean
  pending?: boolean
  pendingLabel?: string
  className?: string
}

/** 历史 Review 与 Live 共用的稳定消息表现；streaming 只改变状态，不切换消息容器。 */
export function TaskMessage({
  role,
  text,
  attachments = [],
  author,
  time,
  meta,
  actions,
  collapsible = true,
  streaming = false,
  pending = false,
  pendingLabel,
  className = '',
}: TaskMessageProps) {
  const { t } = useTranslation('task')
  const user = role === 'user'
  const resolvedAuthor = author ?? (user ? t('message.you') : t('message.agent'))
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
    // Agent 正文默认完整展开；流式阶段不做五行折叠测量，也不重建 ResizeObserver。
    setExpanded(!user)
    if (streaming && !user && view === 'rendered') {
      setCanCollapse(false)
      setCollapsedHeight(undefined)
      return
    }
    const element = surfaceRef.current
    if (!element) return
    const frame = window.requestAnimationFrame(measure)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [measure, streaming, user, view])

  const roleClass = user ? 'task-message-user' : 'task-message-assistant'
  const bubbleClass = user ? 'task-message-bubble-user' : 'task-message-bubble-assistant'

  return <div
    className={`task-message-row ${roleClass} ${className}`.trim()}
    data-task-message-role={role}
    data-streaming={streaming ? 'true' : undefined}
    data-pending={pending ? 'true' : undefined}
    aria-busy={streaming || pending || undefined}
  >
    <div className={`task-message-bubble ${bubbleClass}`}>
      <div className="task-message-meta"><b>{resolvedAuthor}</b>{meta}{time && <time>{time}</time>}</div>
      {pending && !user ? <div
        className="task-message-response-pending"
        role="status"
        aria-live="polite"
        aria-label={pendingLabel ?? t('message.waitingResponse')}
      >
        <span aria-hidden="true"/>
        <span aria-hidden="true"/>
        <span aria-hidden="true"/>
      </div> : <>
        {attachments.some(attachment => attachment.type === 'image' && attachment.dataUrl) && <div className="task-message-attachments">
          {attachments.map((attachment, index) => attachment.type === 'image' && attachment.dataUrl
            ? <img
                key={`${attachment.type}:${attachment.name ?? index}:${index}`}
                className="task-message-attachment-image"
                src={attachment.dataUrl}
                alt={attachment.name ?? t('message.imageAttachment')}
                loading="lazy"
                decoding="async"
              />
            : null)}
        </div>}
        {text && <div className="markdown-message task-message-content" data-view={view}>
          <div
            ref={surfaceRef}
            className={`markdown-surface ${canCollapse && !expanded ? 'is-collapsed' : ''}`}
            style={canCollapse && !expanded && collapsedHeight ? { maxHeight: `${collapsedHeight}px` } : undefined}
          >
            {view === 'rendered' ? <MarkdownContent text={text} streaming={streaming}/> : <CopyableCodeBlock className="markdown-source" copyValue={text}>{text}</CopyableCodeBlock>}
            {canCollapse && !expanded && <span className="markdown-fade" aria-hidden="true"/>}
          </div>
          {(canCollapse || !user) && <div className="markdown-message-actions">
            {canCollapse && <button type="button" onClick={() => setExpanded(value => !value)}>{expanded ? t('message.collapseFiveLines') : t('message.expand')}</button>}
            {!user && <button type="button" title={view === 'rendered' ? t('message.viewMarkdownSource') : t('message.returnRendered')} onClick={() => setView(value => value === 'rendered' ? 'source' : 'rendered')}>
              {view === 'rendered' ? <span>{t('message.source')}</span> : <span>{t('message.rendered')}</span>}
            </button>}
          </div>}
        </div>}
      </>}
      {actions && <div className="task-message-actions">{actions}</div>}
    </div>
  </div>
}
