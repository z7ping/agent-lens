import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ReviewMessageAttachmentDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { MarkdownContent } from '../components/MarkdownContent'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { copyText } from '../client/clipboard'
import { IconButton, UiIcon } from '../components/ui'

export type TaskMessageRole = 'user' | 'assistant'

export type TaskMessageAttachment = ReviewMessageAttachmentDto & {
  /** Web-local optimistic preview. Never crosses the Live/Review protocol boundary. */
  previewUrl?: string | undefined
}

const EMPTY_TASK_MESSAGE_ATTACHMENTS: readonly TaskMessageAttachment[] = []

export interface TaskMessageProps {
  role: TaskMessageRole
  text: string
  attachments?: readonly TaskMessageAttachment[] | undefined
  author?: string
  modelLabel?: string | undefined
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
  attachments = EMPTY_TASK_MESSAGE_ATTACHMENTS,
  author,
  modelLabel,
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
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const surfaceRef = useRef<HTMLDivElement>(null)
  const copyResetTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => {
    for (const attachment of attachments) {
      if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
    }
  }, [attachments])

  useEffect(() => () => window.clearTimeout(copyResetTimer.current), [])

  const copyMessage = async () => {
    window.clearTimeout(copyResetTimer.current)
    try {
      await copyText(text)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
    copyResetTimer.current = window.setTimeout(() => setCopyState('idle'), 1800)
  }

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
    data-model-label={modelLabel || undefined}
    aria-busy={streaming || pending || undefined}
  >
    <div className={`task-message-bubble ${bubbleClass}`}>
      {!user && modelLabel && <div className="task-message-model-meta">
        <b>{resolvedAuthor}</b><span aria-hidden="true">·</span><span className="task-message-model-label">{modelLabel}</span>{time && <time>{time}</time>}
      </div>}
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
        {attachments.length > 0 && <div className="task-message-attachments">
          {attachments.map((attachment, index) => {
            const key = `${attachment.type}:${attachment.name ?? index}:${index}`
            if (attachment.type === 'file') {
              return <span key={key} className="task-message-file-attachment">
                {attachment.name ?? t('message.fileAttachment')}
              </span>
            }
            const source = attachment.previewUrl || attachment.dataUrl
            return source
              ? <img
                  key={key}
                  className="task-message-attachment-image"
                  src={source}
                  alt={attachment.name ?? t('message.imageAttachment')}
                  loading="lazy"
                  decoding="async"
                />
              : <span
                  key={key}
                  className="task-message-attachment-placeholder"
                >{attachment.name ?? t('message.imageAttachment')}</span>
          })}
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
            {!user && <IconButton
              size="small"
              className="task-message-copy-action"
              data-copy-state={copyState}
              aria-label={copyState === 'copied' ? t('message.copied') : copyState === 'error' ? t('message.copyFailed') : t('message.copy')}
              title={copyState === 'copied' ? t('message.copied') : copyState === 'error' ? t('message.copyFailed') : t('message.copy')}
              onClick={() => void copyMessage()}
            ><UiIcon name={copyState === 'copied' ? 'check' : 'copy'} size={14}/></IconButton>}
            {canCollapse && <button type="button" onClick={() => setExpanded(value => !value)}>{expanded ? t('message.collapseFiveLines') : t('message.expand')}</button>}
            {!user && <button type="button" className="task-message-source-action" title={view === 'rendered' ? t('message.viewMarkdownSource') : t('message.returnRendered')} onClick={() => setView(value => value === 'rendered' ? 'source' : 'rendered')}>
              {view === 'rendered' ? <span>{t('message.source')}</span> : <span>{t('message.rendered')}</span>}
            </button>}
          </div>}
        </div>}
      </>}
      {actions && <div className="task-message-actions">{actions}</div>}
    </div>
  </div>
}
