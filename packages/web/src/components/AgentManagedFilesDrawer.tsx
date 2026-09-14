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
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { LocalPathActions } from './LocalPathActions'
import { Button, Drawer, UiIcon } from './ui'

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
  const [error, setError] = useState('')
  const [pathError, setPathError] = useState('')
  const generationRef = useRef(0)

  const loadDirectory = useCallback(async (path: string, generation = generationRef.current) => {
    setLoadingDirectories(current => new Set(current).add(path))
    try {
      const response = await model.managedAssetDirectory(productId, installationId, root, path, bindingId)
      if (generationRef.current !== generation) return
      setDirectories(current => ({ ...current, [path]: response }))
      setError('')
    } catch (loadError) {
      if (generationRef.current !== generation) return
      setError(managedFileErrorMessage(loadError, t))
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
    setPreviewLoading(true)
    try {
      const result = await model.managedAssetFile(
        productId,
        installationId,
        'binding',
        '',
        bindingId,
      )
      if (generationRef.current !== generation) return
      setPreview(result)
      setError('')
    } catch (previewError) {
      if (generationRef.current !== generation) return
      if (managedFileStatus(previewError) === 400) {
        setBindingDirectory(true)
        void loadDirectory('', generation)
        return
      }
      setError(managedFileErrorMessage(previewError, t))
    } finally {
      if (generationRef.current === generation) setPreviewLoading(false)
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
    setError('')
    setPathError('')
    if (root === 'binding') void loadBindingTarget(generation)
    else void loadDirectory('', generation)
    return () => {
      generationRef.current += 1
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

  const selectFile = async (entry: ManagedAssetFileEntryDto) => {
    if (!entry.accessible || entry.kind !== 'file') return
    setSelected(entry)
    setPreview(null)
    setError('')
    if (!entry.previewable) return

    const generation = generationRef.current
    setPreviewLoading(true)
    try {
      const result = await model.managedAssetFile(
        productId,
        installationId,
        root,
        entry.relativePath,
        bindingId,
      )
      if (generationRef.current !== generation) return
      setPreview(result)
    } catch (previewError) {
      if (generationRef.current !== generation) return
      setError(managedFileErrorMessage(previewError, t))
    } finally {
      if (generationRef.current === generation) setPreviewLoading(false)
    }
  }

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
  const reportPathError = (reason: unknown) => {
    setPathError(reason instanceof Error ? reason.message : String(reason))
  }
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

  return <Drawer
    open={open}
    className="agent-managed-files-drawer"
    title={t('managedFiles.title', { agent: agentName, root: rootLabel })}
    description={rootPath}
    onClose={onClose}
  >
    <div className={`managed-files-layout ${previewOnly ? 'is-preview-only' : ''}`}>
      {!previewOnly && <section className="managed-files-tree" aria-label={t('managedFiles.treeAria')}>
        <div className="managed-files-root">
          <span>{rootLabel}</span>
          <div className="managed-files-root-path">
            <code title={rootPath}>{rootPath}</code>
            <LocalPathActions path={rootPath} onOpen={model.openHostPath} onError={reportPathError}/>
          </div>
        </div>
        {error && !Object.keys(directories).length
          ? <div className="managed-file-error">
              <p>{error}</p>
              <Button size="small" onClick={() => void loadDirectory('')}>{t('managedFiles.retry')}</Button>
            </div>
          : renderDirectory('')}
      </section>}
      <section className="managed-file-preview" aria-label={t('managedFiles.previewAria')}>
        {previewName && <div className="managed-file-preview-head">
          <div>
            <b>{previewName}</b>
            <span>{previewPath}</span>
          </div>
          <div className="managed-file-preview-facts">
            {preview?.redacted && <span className="managed-file-redacted">{t('managedFiles.redacted')}</span>}
            {previewSize !== undefined && <small>{t('managedFiles.bytes', { count: previewSize })}</small>}
            <LocalPathActions path={previewTargetPath} onOpen={model.openHostPath} onError={reportPathError}/>
          </div>
        </div>}
        {pathError && <div className="managed-file-path-error" role="alert">{pathError}</div>}
        {previewLoading
          ? <div className="managed-file-preview-empty">{t('managedFiles.loadingPreview')}</div>
          : preview?.content !== undefined
            ? <CopyableCodeBlock className="managed-file-preview-content" copyValue={preview.content}><code>{preview.content}</code></CopyableCodeBlock>
            : preview?.previewStatus === 'metadata-only'
              ? <div className="managed-file-preview-empty">
                  <UiIcon name="exclamation" size={20}/>
                  <span>{t('managedFiles.metadataOnly')}</span>
                  <small>{metadataOnlyMessage}</small>
                </div>
              : <div className="managed-file-preview-empty">
                <UiIcon name={selected?.sensitive ? 'alert' : 'tool-read'} size={20}/>
                <span>{selectedMessage}</span>
                {error && <small>{error}</small>}
                {error && previewOnly && <Button size="small" onClick={() => void loadBindingTarget()}>{t('managedFiles.retry')}</Button>}
              </div>}
      </section>
    </div>
  </Drawer>
}