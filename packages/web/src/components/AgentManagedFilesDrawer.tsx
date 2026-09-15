import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type {
  ManagedAssetDirectoryResponseDto,
  ManagedAssetFileEntryDto,
  ManagedAssetFilePreviewResponseDto,
  ManagedAssetRoot,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { readMarkdownTheme, writeMarkdownTheme } from '../client/preferences'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { LocalPathActions } from './LocalPathActions'
import { MarkdownContent } from './MarkdownContent'
import { isMarkdownThemeId } from './markdown-theme'
import { Button, Dialog, Drawer, SelectMenu, UiIcon } from './ui'

function isMarkdownFile(name: string | undefined): boolean {
  return Boolean(name && /\.(?:md|markdown|mdown|mkd)$/i.test(name))
}

function localPath(rootPath: string, relativePath: string): string {
  if (!relativePath) return rootPath
  const separator = rootPath.includes('\\') ? '\\' : '/'
  const root = rootPath.replace(/[\\/]+$/, '')
  const child = relativePath.replaceAll('/', separator)
  return `${root}${separator}${child}`
}

function managedFileStatus(error: unknown): number | undefined {
  const status = error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined
  return typeof status === 'number' ? status : undefined
}

function managedPreviewBlockedMessage(
  reason: ManagedAssetFilePreviewResponseDto['blockedReason'],
  t: TFunction,
): string {
  if (!reason) return t('managedFiles.previewUnavailable')
  return t(`managedFiles.blockedReason.${reason}`)
}

function managedFileErrorMessage(error: unknown, t: TFunction): string {
  const status = managedFileStatus(error)
  if (status === 403) return t('managedFiles.errorForbidden')
  if (status === 404) return t('managedFiles.errorNotFound')
  if (status === 413) return t('managedFiles.errorTooLarge')
  if (status === 415) return t('managedFiles.errorUnsupported')
  return t('managedFiles.errorGeneric')
}

interface AgentManagedFilesDrawerProps {
  open: boolean
  model: AgentLensClientModel
  productId: string
  agentName: string
  installationId: string
  root: ManagedAssetRoot
  bindingId?: string
  rootLabel: string
  rootPath: string
  onClose(): void
}


export function AgentManagedFilesDrawer({
  open,
  model,
  productId,
  agentName,
  installationId,
  root,
  bindingId,
  rootLabel,
  rootPath,
  onClose,
}: AgentManagedFilesDrawerProps) {
  const { t } = useTranslation('agents')
  const [directories, setDirectories] = useState<Record<string, ManagedAssetDirectoryResponseDto>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<ManagedAssetFileEntryDto | null>(null)
  const [preview, setPreview] = useState<ManagedAssetFilePreviewResponseDto | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [bindingDirectory, setBindingDirectory] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [pathError, setPathError] = useState('')
  const [previewView, setPreviewView] = useState<'rendered' | 'source'>('source')
  const [markdownTheme, setMarkdownTheme] = useState(readMarkdownTheme)
  const generationRef = useRef(0)
  const previewRequestRef = useRef(0)

  const loadDirectory = useCallback(async (path: string, generation = generationRef.current) => {
    setLoadingDirectories(current => new Set(current).add(path))
    try {
      const response = await model.managedAssetDirectory(productId, installationId, root, path, bindingId)
      if (generationRef.current !== generation) return
      setDirectories(current => ({ ...current, [path]: response }))
      setDirectoryError('')
    } catch (loadError) {
      if (generationRef.current !== generation) return
      setDirectoryError(managedFileErrorMessage(loadError, t))
    } finally {
      if (generationRef.current === generation) {
        setLoadingDirectories(current => {
          const next = new Set(current)
          next.delete(path)
          return next
        })
      }
    }
  }, [bindingId, installationId, model, productId, root, t])

  const loadBindingTarget = useCallback(async (generation = generationRef.current) => {
    const request = previewRequestRef.current + 1
    previewRequestRef.current = request
    setPreviewLoading(true)
    setPreviewError('')
    try {
      const result = await model.managedAssetFile(
        productId,
        installationId,
        'binding',
        '',
        bindingId,
      )
      if (generationRef.current !== generation || previewRequestRef.current !== request) return
      setPreview(result)
      setPreviewView(isMarkdownFile(result.name) ? 'rendered' : 'source')
    } catch (error) {
      if (generationRef.current !== generation || previewRequestRef.current !== request) return
      if (managedFileStatus(error) === 409) {
        setBindingDirectory(true)
        void loadDirectory('', generation)
        return
      }
      setPreviewError(managedFileErrorMessage(error, t))
    } finally {
      if (generationRef.current === generation && previewRequestRef.current === request) {
        setPreviewLoading(false)
      }
    }
  }, [bindingId, installationId, loadDirectory, model, productId, t])

  useEffect(() => {
    if (!open) return
    const generation = generationRef.current + 1
    generationRef.current = generation
    setDirectories({})
    setExpanded(new Set())
    setLoadingDirectories(new Set())
    setSelected(null)
    setPreview(null)
    setPreviewLoading(false)
    setBindingDirectory(false)
    setDirectoryError('')
    setPreviewError('')
    setPathError('')
    setPreviewView('source')
    previewRequestRef.current += 1
    if (root === 'binding') void loadBindingTarget(generation)
    else void loadDirectory('', generation)
    return () => {
      generationRef.current += 1
      previewRequestRef.current += 1
    }
  }, [open, productId, installationId, root, loadBindingTarget, loadDirectory])

  const toggleDirectory = (entry: ManagedAssetFileEntryDto) => {
    if (!entry.accessible || entry.kind !== 'directory') return
    const opening = !expanded.has(entry.relativePath)
    setExpanded(current => {
      const next = new Set(current)
      if (opening) next.add(entry.relativePath)
      else next.delete(entry.relativePath)
      return next
    })
    if (opening && !directories[entry.relativePath] && !loadingDirectories.has(entry.relativePath)) {
      void loadDirectory(entry.relativePath)
    }
  }

  const selectFile = useCallback(async (entry: ManagedAssetFileEntryDto) => {
    if (!entry.accessible || entry.kind !== 'file') return
    const generation = generationRef.current
    const request = previewRequestRef.current + 1
    previewRequestRef.current = request
    setSelected(entry)
    setPreview(null)
    setPreviewView(isMarkdownFile(entry.name) ? 'rendered' : 'source')
    setPreviewError('')
    setPreviewLoading(true)

    try {
      const result = await model.managedAssetFile(
        productId,
        installationId,
        root,
        entry.relativePath,
        bindingId,
      )
      if (generationRef.current !== generation || previewRequestRef.current !== request) return
      setPreview(result)
    } catch (error) {
      if (generationRef.current !== generation || previewRequestRef.current !== request) return
      setPreviewError(managedFileErrorMessage(error, t))
    } finally {
      if (generationRef.current === generation && previewRequestRef.current === request) {
        setPreviewLoading(false)
      }
    }
  }, [bindingId, installationId, model, productId, root, t])

  useEffect(() => {
    if (!open || root !== 'binding' || !bindingDirectory || selected) return
    const skillEntry = directories['']?.entries.find(entry =>
      entry.kind === 'file'
      && entry.accessible
      && entry.name.toLowerCase() === 'skill.md'
    )
    if (skillEntry) void selectFile(skillEntry)
  }, [bindingDirectory, directories, open, root, selectFile, selected])

  const renderDirectory = (path: string): ReactNode => {
    const directory = directories[path]
    if (!directory) {
      return loadingDirectories.has(path)
        ? <div className="managed-file-loading">{t('managedFiles.loading')}</div>
        : null
    }

    if (!directory.entries.length) {
      return <div className="managed-file-loading">{t('managedFiles.emptyDirectory')}</div>
    }

    return directory.entries.map(entry => {
      const isDirectory = entry.kind === 'directory'
      const isExpanded = isDirectory && expanded.has(entry.relativePath)
      const isSelected = selected?.relativePath === entry.relativePath
      return <div key={entry.relativePath} className="managed-file-node">
        <button
          type="button"
          className="managed-file-row"
          data-selected={isSelected || undefined}
          data-disabled={!entry.accessible || undefined}
          disabled={!entry.accessible}
          title={entry.relativePath}
          onClick={() => isDirectory ? toggleDirectory(entry) : void selectFile(entry)}
        >
          <span className="managed-file-chevron" aria-hidden="true">
            {isDirectory
              ? <UiIcon name="chevron-right" size={14} className={isExpanded ? 'is-expanded' : undefined}/>
              : <span className="managed-file-leaf-dot">·</span>}
          </span>
          <span className="managed-file-name">{entry.name}</span>
          {entry.symlink && <span className="managed-file-meta">{t('managedFiles.symlink')}</span>}
          {entry.sensitive && <span className="managed-file-meta is-warning">{t('managedFiles.sensitive')}</span>}
          {entry.kind === 'file' && !entry.sensitive && !entry.previewable && <span className="managed-file-meta">{t('managedFiles.noPreview')}</span>}
          {!entry.accessible && <span className="managed-file-meta is-warning">{t('managedFiles.outsideRoot')}</span>}
        </button>
        {isDirectory && isExpanded && <div className="managed-file-children">
          {loadingDirectories.has(entry.relativePath) && !directories[entry.relativePath]
            ? <div className="managed-file-loading">{t('managedFiles.loading')}</div>
            : renderDirectory(entry.relativePath)}
        </div>}
      </div>
    })
  }

  const previewOnly = root === 'binding' && !bindingDirectory
  const previewName = selected?.name ?? preview?.name
  const previewPath = selected?.relativePath || preview?.relativePath || rootPath
  const previewSize = selected?.size ?? preview?.size
  const previewTargetPath = localPath(rootPath, selected?.relativePath ?? preview?.relativePath ?? '')
  const openPath = (path: string) => {
    setPathError('')
    return model.openHostPath(path)
  }
  const reportPathError = (reason: unknown) => {
    setPathError(reason instanceof Error ? reason.message : String(reason))
  }
  const previewMarkdown = isMarkdownFile(previewName)
  const documentPreview = previewOnly && isMarkdownFile(previewName ?? rootPath)
  const metadataOnlyMessage = preview?.previewStatus === 'metadata-only'
    ? managedPreviewBlockedMessage(preview.blockedReason, t)
    : ''

  const selectedMessage = selected?.sensitive
    ? t('managedFiles.sensitiveBlocked')
    : selected && !selected.previewable
      ? t('managedFiles.previewUnavailable')
      : previewOnly
        ? t('managedFiles.previewUnavailable')
        : t('managedFiles.selectFile')

  const content = <div className={`managed-files-layout ${previewOnly ? 'is-preview-only' : ''} ${documentPreview ? 'is-document-preview' : ''}`.trim()}>

      {!previewOnly && <section className="managed-files-tree" aria-label={t('managedFiles.treeAria')}>
        <div className="managed-files-root">
          <span>{rootLabel}</span>
          <div className="managed-files-root-path">
            <code title={rootPath}>{rootPath}</code>
            <LocalPathActions path={rootPath} onOpen={openPath} onError={reportPathError}/>
          </div>
        </div>
        {directoryError && !Object.keys(directories).length
          ? <div className="managed-file-error">
              <p>{directoryError}</p>
              <Button size="small" onClick={() => void loadDirectory('')}>{t('managedFiles.retry')}</Button>
            </div>
          : renderDirectory('')}
      </section>}
      <section className="managed-file-preview" aria-label={t('managedFiles.previewAria')}>
        {previewName && <div className="managed-file-preview-head" data-document={documentPreview || undefined}>
          <div>
            <b>{previewName}</b>
            <span>{previewPath}</span>
          </div>
          <div className="managed-file-preview-facts">
            {preview?.redacted && <span className="managed-file-redacted">{t('managedFiles.redacted')}</span>}
            {previewSize !== undefined && <small>{t('managedFiles.bytes', { count: previewSize })}</small>}
            {previewMarkdown && previewView === 'rendered' && <SelectMenu
              className="managed-file-theme-select"
              value={markdownTheme}
              onChange={value => {
                if (!isMarkdownThemeId(value)) return
                setMarkdownTheme(value)
                writeMarkdownTheme(value)
              }}
              ariaLabel={t('managedFiles.themeAria')}
              menuWidth={220}
              options={[
                { value: 'next-helvetica', label: t('managedFiles.themeNextHelvetica'), description: t('managedFiles.themeNextHelveticaDescription') },
                { value: 'agent-lens', label: t('managedFiles.themeAgentLens'), description: t('managedFiles.themeAgentLensDescription') },
              ]}
            />}
            {previewMarkdown && preview?.content !== undefined && <div className="managed-file-view-toggle" role="group" aria-label={t('managedFiles.viewMode')}>
              <button type="button" aria-pressed={previewView === 'rendered'} onClick={() => setPreviewView('rendered')}>{t('managedFiles.rendered')}</button>
              <button type="button" aria-pressed={previewView === 'source'} onClick={() => setPreviewView('source')}>{t('managedFiles.source')}</button>
            </div>}
            <LocalPathActions path={previewTargetPath} onOpen={openPath} onError={reportPathError}/>
          </div>
        </div>}
        {pathError && <div className="managed-file-path-error" role="alert">{pathError}</div>}
        {previewLoading
          ? <div className="managed-file-preview-empty">{t('managedFiles.loadingPreview')}</div>
          : preview?.content !== undefined
            ? previewMarkdown && previewView === 'rendered'
              ? <div className="managed-file-document-scroll"><MarkdownContent text={preview.content} className="managed-file-markdown" theme={markdownTheme}/></div>
              : <CopyableCodeBlock className="managed-file-preview-content" copyValue={preview.content}><code>{preview.content}</code></CopyableCodeBlock>
            : preview?.previewStatus === 'metadata-only'
              ? <div className="managed-file-preview-empty">
                  <UiIcon name="exclamation" size={20}/>
                  <span>{t('managedFiles.metadataOnly')}</span>
                  <small>{metadataOnlyMessage}</small>
                </div>
              : <div className="managed-file-preview-empty">
                <UiIcon name={selected?.sensitive ? 'alert' : 'tool-read'} size={20}/>
                <span>{selectedMessage}</span>
                {previewError && <small>{previewError}</small>}
                {previewError && previewOnly && <Button size="small" onClick={() => void loadBindingTarget()}>{t('managedFiles.retry')}</Button>}
              </div>}
      </section>
    </div>

  if (documentPreview) {
    return <Dialog
      open={open}
      className="agent-managed-file-document-dialog"
      title={previewName ?? rootLabel}
      description={rootPath}
      onClose={onClose}
    >{content}</Dialog>
  }

  return <Drawer
    open={open}
    className="agent-managed-files-drawer"
    title={t('managedFiles.title', { agent: agentName, root: rootLabel })}
    description={rootPath}
    onClose={onClose}
  >{content}</Drawer>
}
