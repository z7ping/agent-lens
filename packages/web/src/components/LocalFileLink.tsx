import { useState, type ComponentPropsWithoutRef, type MouseEvent } from 'react'
import type { HostFilePreviewResponseDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { clientModel } from '../client/model'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { LocalPathActions } from './LocalPathActions'
import { Dialog, UiIcon } from './ui'

export interface LocalFileTarget {
  path: string
  line?: number
  column?: number
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function fileUrlPath(value: string): string | null {
  if (!/^file:\/\//i.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    const decoded = decodePath(url.pathname)
    if (url.hostname) {
      return `\\\\${url.hostname}${decoded.replaceAll('/', '\\')}`
    }
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded
  } catch {
    return null
  }
}

function looksLikePosixFilePath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false
  if (/^\/(?:home|Users|mnt|tmp|var|etc|opt|srv|data|workspace|workspaces|Volumes)(?:\/|$)/.test(value)) return true
  const leaf = value.split('/').filter(Boolean).at(-1) ?? ''
  return /\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf)
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value)
    || looksLikePosixFilePath(value)
}

function stripLocation(value: string): LocalFileTarget | null {
  const hash = value.match(/^(.*)#L(\d+)(?:C(\d+))?$/i)
  if (hash && isAbsoluteLocalPath(hash[1]!)) {
    return {
      path: hash[1]!,
      line: Number(hash[2]),
      ...(hash[3] ? { column: Number(hash[3]) } : {}),
    }
  }

  const lineColumn = value.match(/^(.*):(\d+):(\d+)$/)
  if (lineColumn && isAbsoluteLocalPath(lineColumn[1]!)) {
    return {
      path: lineColumn[1]!,
      line: Number(lineColumn[2]),
      column: Number(lineColumn[3]),
    }
  }

  const lineOnly = value.match(/^(.*):(\d+)$/)
  if (lineOnly && isAbsoluteLocalPath(lineOnly[1]!)) {
    return {
      path: lineOnly[1]!,
      line: Number(lineOnly[2]),
    }
  }

  return isAbsoluteLocalPath(value) ? { path: value } : null
}

export function parseLocalFileTarget(href: string | undefined): LocalFileTarget | null {
  const raw = href?.trim()
  if (!raw) return null

  const fileHash = raw.match(/^(file:\/\/.*)#L(\d+)(?:C(\d+))?$/i)
  if (fileHash) {
    const path = fileUrlPath(fileHash[1]!)
    if (!path) return null
    return {
      path,
      line: Number(fileHash[2]),
      ...(fileHash[3] ? { column: Number(fileHash[3]) } : {}),
    }
  }

  const filePath = fileUrlPath(raw)
  return stripLocation(filePath ?? decodePath(raw))
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function blockedLabel(
  reason: HostFilePreviewResponseDto['blockedReason'],
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return reason
    ? t(`localFilePreview.blockedReason.${reason}`)
    : t('localFilePreview.unavailable')
}

type LocalFileLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & { href?: string | undefined }

export function LocalFileLink({
  href,
  children,
  ...props
}: LocalFileLinkProps) {
  const { t } = useTranslation('common')
  const target = parseLocalFileTarget(href)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<HostFilePreviewResponseDto | null>(null)
  const [error, setError] = useState('')

  if (!target) return <a href={href} {...props}>{children}</a>

  const showPreview = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    setOpen(true)
    setLoading(true)
    setPreview(null)
    setError('')
    try {
      setPreview(await clientModel.previewHostFile(target.path))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  const location = target.line
    ? target.column
      ? t('localFilePreview.lineColumn', { line: target.line, column: target.column })
      : t('localFilePreview.line', { line: target.line })
    : ''

  return <>
    <a
      href={href}
      {...props}
      className={`${props.className ?? ''} markdown-local-file-link`.trim()}
      title={target.path}
      onClick={event => void showPreview(event)}
    >{children}</a>
    <Dialog
      open={open}
      size="xlarge"
      className="local-file-preview-dialog"
      title={fileName(target.path)}
      description={<span title={target.path}>{target.path}{location ? ` · ${location}` : ''}</span>}
      headerActions={<LocalPathActions path={target.path} onOpen={clientModel.openHostPath}/>}
      onClose={() => setOpen(false)}
    >
      <section className="local-file-preview-body">
        {loading
          ? <div className="local-file-preview-state">{t('localFilePreview.loading')}</div>
          : error
            ? <div className="local-file-preview-state is-error" role="alert">
                <UiIcon name="exclamation" size={20}/>
                <span>{t('localFilePreview.failed')}</span>
                <small>{error}</small>
              </div>
            : preview?.content !== undefined
              ? <CopyableCodeBlock className="local-file-preview-content" copyValue={preview.content}><code>{preview.content}</code></CopyableCodeBlock>
              : preview
                ? <div className="local-file-preview-state">
                    <UiIcon name="exclamation" size={20}/>
                    <span>{t('localFilePreview.metadataOnly')}</span>
                    <small>{blockedLabel(preview.blockedReason, t)}</small>
                  </div>
                : null}
      </section>
    </Dialog>
  </>
}
