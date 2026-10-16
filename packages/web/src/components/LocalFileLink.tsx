import { useState, type ComponentPropsWithoutRef, type MouseEvent } from 'react'
import type { HostFilePreviewResponseDto } from '@agent-lens/protocol'
import { AgentLensRequestError } from '../client/api'
import { useTranslation } from 'react-i18next'
import { clientModel } from '../client/model'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { MarkdownContent } from './MarkdownContent'
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

  const suffix = value.match(/^(.*):(\d+):(\d+)$/) ?? value.match(/^(.*):(\d+)$/)
  if (suffix && isAbsoluteLocalPath(suffix[1]!)) {
    return {
      path: suffix[1]!,
      line: Number(suffix[2]),
      ...(suffix[3] ? { column: Number(suffix[3]) } : {}),
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

export type LocalLinkResourceKind = 'file' | 'directory' | 'path'
export type LocalLinkPresentation = 'markdown' | 'code' | 'file' | 'directory' | 'path' | 'web' | 'other'

/** Explicit kinds win; ambiguous extensionless paths are not presumed to be directories. */
export function classifyLocalLink(href: string | undefined, kind?: LocalLinkResourceKind): LocalLinkPresentation {
  const target = parseLocalFileTarget(href)
  if (!target) return /^https?:\/\//i.test(href ?? '') ? 'web' : 'other'
  if (kind === 'directory') return 'directory'
  if (kind === 'path') return 'path'
  if (!kind && /[\\/]$/.test(target.path)) return 'directory'
  const name = fileName(target.path)
  if (kind !== 'file' && !/\.[a-z0-9][a-z0-9_-]*$/i.test(name)) return 'path'
  if (/\.(?:md|markdown|mdown|mkd)$/i.test(name)) return 'markdown'
  if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx|css|scss|html|xml|jsonc?|ya?ml|toml|py|java|go|rs|cpp|cc|c|h|hpp|sql|sh|ps1|vue|svelte|kt|swift|rb|php)$/i.test(name)) return 'code'
  return 'file'
}

function blockedLabel(
  reason: HostFilePreviewResponseDto['blockedReason'],
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return reason
    ? t(`localFilePreview.blockedReason.${reason}`)
    : t('localFilePreview.unavailable')
}

type LocalFileLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & {
  href?: string | undefined
  resourceKind?: LocalLinkResourceKind
}

export function LocalFileLink({
  href,
  children,
  resourceKind,
  ...props
}: LocalFileLinkProps) {
  const { t } = useTranslation('common')
  const target = parseLocalFileTarget(href)
  const presentation = classifyLocalLink(href, resourceKind)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'rendered' | 'source'>('source')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<HostFilePreviewResponseDto | null>(null)
  const [error, setError] = useState('')

  if (!target) return <a
    href={href}
    {...props}
    className={[props.className, presentation === 'web' ? 'markdown-external-link' : ''].filter(Boolean).join(' ')}
  >{children}{presentation === 'web' && <UiIcon className="markdown-link-type-icon" name="tool-web" size={14}/>}</a>

  const openDirectory = async () => {
    try {
      await clientModel.openHostPath(target.path)
      setOpen(false)
    } catch (reason) {
      setOpen(true)
      setLoading(false)
      setError(reason instanceof AgentLensRequestError && reason.status === 501
        ? t('localPath.unsupported')
        : reason instanceof Error ? reason.message : String(reason))
    }
  }

  const showPreview = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (presentation === 'directory') {
      setPreview(null)
      setError('')
      await openDirectory()
      return
    }
    setOpen(true)
    setLoading(true)
    setPreview(null)
    setError('')
    try {
      const result = await clientModel.previewHostFile(target.path)
      setPreview(result)
      setView(/\.(?:md|markdown|mdown|mkd)$/i.test(result.name) ? 'rendered' : 'source')
    } catch (reason) {
      if (reason instanceof AgentLensRequestError && reason.status === 409) {
        await openDirectory()
        return
      }
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

  const isMarkdown = Boolean(preview?.content !== undefined && /\.(?:md|markdown|mdown|mkd)$/i.test(preview.name))

  const icon = presentation === 'markdown' ? 'tool-read'
    : presentation === 'code' ? 'file-code'
      : presentation === 'file' ? 'file'
        : presentation === 'directory' ? 'folder-open' : 'link'

  return <>
    <a
      href={href}
      {...props}
      className={[props.className, 'markdown-local-file-link', 'is-' + presentation].filter(Boolean).join(' ')}
      title={target.path}
      onClick={event => void showPreview(event)}
    ><UiIcon className="markdown-link-type-icon" name={icon} size={14}/>{children}</a>
    <Dialog
      open={open}
      size="xlarge"
      className="local-file-preview-dialog"
      title={fileName(target.path)}
      description={<span title={target.path}>{target.path}{location ? ` · ${location}` : ''}</span>}
      headerActions={<>
        {isMarkdown && <div className="file-preview-view-toggle" role="group" aria-label={t('localFilePreview.viewMode')}>
          <button type="button" aria-pressed={view === 'rendered'} onClick={() => setView('rendered')}>{t('localFilePreview.rendered')}</button>
          <button type="button" aria-pressed={view === 'source'} onClick={() => setView('source')}>{t('localFilePreview.source')}</button>
        </div>}
        <LocalPathActions path={target.path} onOpen={clientModel.openHostPath}/>
      </>}
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
              ? isMarkdown && view === 'rendered'
                ? <div className="local-file-preview-markdown"><MarkdownContent text={preview.content} frontmatter/></div>
                : <CopyableCodeBlock className="local-file-preview-content" copyValue={preview.content}><code>{preview.content}</code></CopyableCodeBlock>
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
