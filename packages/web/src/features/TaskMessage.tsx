import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ReviewMessageAttachmentDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { MarkdownContent } from '../components/MarkdownContent'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { copyText } from '../client/clipboard'
import { IconButton, UiIcon } from '../components/ui'
import { ImagePreview } from '../components/ImagePreview'

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
  author?: string | undefined
  modelLabel?: string | undefined
  time?: string | undefined
  meta?: ReactNode | undefined
  actions?: ReactNode | undefined
  collapsible?: boolean | undefined
  streaming?: boolean | undefined
  /** Hide copy/source controls for process and non-final assistant chunks. */
  showContentActions?: boolean | undefined
  pending?: boolean | undefined
  pendingLabel?: string | undefined
  className?: string | undefined
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
  showContentActions = true,
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
    if (!element || !collapsible || !user) {
      setCanCollapse(false)
      return
    }
    const style = window.getComputedStyle(element)
    const fontSize = Number.parseFloat(style.fontSize) || 14
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.65
    const limit = Math.ceil(lineHeight * 5 + 2)
    setCollapsedHeight(limit)
    setCanCollapse(element.scrollHeight > limit + 2)
  }, [collapsible, user])

  useEffect(() => {
    // 只在消息角色切换时重设；切换源码/渲染视图不得覆盖用户的折叠选择。
    setExpanded(!user)
  }, [user])

  useLayoutEffect(() => {
    // Agent 正文始终完整展示；只有用户长消息参与折叠测量。
    if (!user || !collapsible) {
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
  }, [collapsible, measure, user, view])

  const awaitingFirstContent = !user && (pending || (streaming && !text && attachments.length === 0))
  const roleClass = user ? 'task-message-user' : 'task-message-assistant'
  const bubbleClass = user ? 'task-message-bubble-user' : 'task-message-bubble-assistant'
  const sourceActionLabel = view === 'rendered' ? t('message.viewMarkdownSource') : t('message.returnRendered')

  return <div
    className={`task-message-row ${roleClass} ${className}`.trim()}
    data-task-message-role={role}
    data-streaming={streaming ? 'true' : undefined}
    data-pending={awaitingFirstContent ? 'true' : undefined}
    data-model-label={modelLabel || undefined}
    aria-busy={streaming || awaitingFirstContent || undefined}
  >
    <div className={`task-message-bubble ${bubbleClass}`}>
      {(modelLabel || time || meta) && <div className="task-message-model-meta">
        <b>{resolvedAuthor}</b>
        {modelLabel && <><span aria-hidden="true">·</span><span className="task-message-model-label">{modelLabel}</span></>}
        {meta && <span className="task-message-context-evidence">{meta}</span>}
        {time && <time>{time}</time>}
      </div>}
      {awaitingFirstContent ? <div
        className="task-message-response-pending"
        role="status"
        aria-live="polite"
        aria-label={pendingLabel ?? t('message.waitingResponse')}
      >
        <span className="task-message-response-activity" aria-hidden="true"><UiIcon name="loading" size={14}/></span>
        <span className="task-message-response-label">{pendingLabel ?? t('message.waitingResponse')}</span>
        <span className="task-message-response-dots" aria-hidden="true"><span/><span/><span/></span>
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
              ? <ImagePreview
                  key={key}
                  src={source}
                  alt={attachment.name ?? t('message.imageAttachment')}
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
          {(canCollapse || Boolean(actions) || (!user && (showContentActions || streaming))) && <div className="markdown-message-actions">
            {!user && streaming && <span className="task-message-output-state" data-active="true" role="status" aria-label={t('message.generating')}>
              <UiIcon name="loading" size={14}/>
            </span>}
            {!user && showContentActions && <IconButton
              size="small"
              className="task-message-copy-action"
              data-copy-state={copyState}
              aria-label={copyState === 'copied' ? t('message.copied') : copyState === 'error' ? t('message.copyFailed') : t('message.copy')}
              title={copyState === 'copied' ? t('message.copied') : copyState === 'error' ? t('message.copyFailed') : t('message.copy')}
              onClick={() => void copyMessage()}
            ><UiIcon name={copyState === 'copied' ? 'check' : 'copy'} size={14}/></IconButton>}
            {user && canCollapse && <button type="button" onClick={() => setExpanded(value => !value)}>{expanded ? t('message.collapse') : t('message.expand')}</button>}
            {!user && showContentActions && <IconButton
              size="small"
              className="task-message-source-action"
              aria-label={sourceActionLabel}
              title={sourceActionLabel}
              aria-pressed={view === 'source'}
              onClick={() => setView(value => value === 'rendered' ? 'source' : 'rendered')}
            ><UiIcon name={view === 'rendered' ? 'file-code' : 'preview'} size={14}/></IconButton>}
            {actions && <span className="task-message-actions">{actions}</span>}
          </div>}
        </div>}
      </>}
      {actions && (!text || awaitingFirstContent) && <div className="task-message-actions">{actions}</div>}
    </div>
  </div>
}
