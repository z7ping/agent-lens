import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentLensRequestError } from '../client/api'
import { copyText } from '../client/clipboard'
import { IconButton, UiIcon } from './ui'

export interface LocalPathActionsProps {
  path: string
  onOpen(path: string): Promise<unknown>
  onError?(error: unknown): void
  className?: string
}

type OpenState = 'idle' | 'opening' | 'opened' | 'revealed' | 'unsupported' | 'failed'

function hostOpenAction(value: unknown): 'opened' | 'revealed' | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const action = Reflect.get(value, 'action')
  return action === 'opened' || action === 'revealed' ? action : undefined
}

export function LocalPathActions({
  path,
  onOpen,
  onError,
  className,
}: LocalPathActionsProps) {
  const { t } = useTranslation('common')
  const [openState, setOpenState] = useState<OpenState>('idle')
  const [copied, setCopied] = useState(false)
  const opening = openState === 'opening'
  const unsupported = openState === 'unsupported'

  const resetOpenState = () => {
    window.setTimeout(() => setOpenState(current => current === 'unsupported' ? current : 'idle'), 2800)
  }

  const open = async () => {
    if (opening || unsupported) return
    setOpenState('opening')
    try {
      const result = await onOpen(path)
      setOpenState(hostOpenAction(result) ?? 'opened')
      resetOpenState()
    } catch (error) {
      const unavailable = error instanceof AgentLensRequestError && error.status === 501
      setOpenState(unavailable ? 'unsupported' : 'failed')
      if (!unavailable) resetOpenState()
      onError?.(error)
    }
  }

  const copy = async () => {
    try {
      await copyText(path)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (error) {
      setCopied(false)
      onError?.(error instanceof Error ? error : new Error(t('localPath.copyFailed')))
    }
  }

  const openLabel = opening
    ? t('localPath.opening')
    : unsupported
      ? t('localPath.unsupported')
      : t('localPath.open')
  const copyLabel = copied ? t('localPath.copied') : t('localPath.copy')
  const feedback = openState === 'opened'
    ? t('localPath.opened')
    : openState === 'revealed'
      ? t('localPath.revealed')
      : openState === 'unsupported'
        ? t('localPath.unsupported')
        : openState === 'failed'
          ? t('localPath.openFailed')
          : ''

  return <span className={`local-path-actions ${className ?? ''}`.trim()}>
    <IconButton
      size="small"
      className="local-path-action"
      aria-label={openLabel}
      title={openLabel}
      disabled={opening || unsupported}
      onClick={() => void open()}
    >
      <UiIcon name={openState === 'opened' || openState === 'revealed' ? 'check' : 'folder-open'} size={14}/>
    </IconButton>
    <IconButton
      size="small"
      className="local-path-action"
      aria-label={copyLabel}
      title={copyLabel}
      onClick={() => void copy()}
    >
      <UiIcon name={copied ? 'check' : 'copy'} size={14}/>
    </IconButton>
    {feedback && <span className={`local-path-feedback is-${openState}`} role="status" aria-live="polite">{feedback}</span>}
  </span>
}
