import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyText } from '../client/clipboard'
import { IconButton, UiIcon } from './ui'

export interface LocalPathActionsProps {
  path: string
  onOpen(path: string): Promise<unknown>
  onError?(error: unknown): void
  className?: string
}

export function LocalPathActions({
  path,
  onOpen,
  onError,
  className,
}: LocalPathActionsProps) {
  const { t } = useTranslation('common')
  const [opening, setOpening] = useState(false)
  const [copied, setCopied] = useState(false)

  const open = async () => {
    if (opening) return
    setOpening(true)
    try {
      await onOpen(path)
    } catch (error) {
      onError?.(error)
    } finally {
      setOpening(false)
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

  const openLabel = opening ? t('localPath.opening') : t('localPath.open')
  const copyLabel = copied ? t('localPath.copied') : t('localPath.copy')

  return <span className={`local-path-actions ${className ?? ''}`.trim()}>
    <IconButton
      size="small"
      className="local-path-action"
      aria-label={openLabel}
      title={openLabel}
      disabled={opening}
      onClick={() => void open()}
    >
      <UiIcon name="folder-open" size={14}/>
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
  </span>
}
