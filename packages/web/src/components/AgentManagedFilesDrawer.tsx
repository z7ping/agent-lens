import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ManagedAssetDirectoryResponseDto,
  ManagedAssetFileEntryDto,
  ManagedAssetFilePreviewResponseDto,
  ManagedAssetRoot,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { Button, Drawer, UiIcon } from './ui'

interface AgentManagedFilesDrawerProps {
  open: boolean
  model: AgentLensClientModel
  productId: string
  installationId: string
  root: ManagedAssetRoot
  rootLabel: string
  rootPath: string
  onClose(): void
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function pathDepth(path: string): number {
  return path ? path.split('/').length : 0
}

export function AgentManagedFilesDrawer({
  open,
  model,
  productId,
  installationId,
  root,
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
  const [error, setError] = useState('')
  const generationRef = useRef(0)

  const loadDirectory = async (path: string, generation = generationRef.current) => {
    setLoadingDirectories(current => new Set(current).add(path))
    try {
      const response = await model.managedAssetDirectory(productId, installationId, root, path)
      if (generationRef.current !== generation) return
      setDirectories(current => ({ ...current, [path]: response }))
      setError('')
    } catch (loadError) {
      if (generationRef.current !== generation) return
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      if (generationRef.current === generation) {
        setLoadingDirectories(current => {
          const next = new Set(current)
          next.delete(path)
          return next
        })
      }
    }
  }

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
    setError('')
    void loadDirectory('', generation)
    return () => {
      generationRef.current += 1
    }
  }, [open, productId, installationId, root])

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
      )
      if (generationRef.current !== generation) return
      setPreview(result)
    } catch (previewError) {
      if (generationRef.current !== generation) return
      setError(previewError instanceof Error ? previewError.message : String(previewError))
    } finally {
      if (generationRef.current === generation) setPreviewLoading(false)
    }
  }

  const renderDirectory = (path: string): React.ReactNode => {
    const directory = directories[path]
    if (!directory) {
      return loadingDirectories.has(path)
        ? <div className="managed-file-loading">{t('managedFiles.loading')}</div>
        : null
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
          title={entry.relativePath}
          onClick={() => isDirectory ? toggleDirectory(entry) : void selectFile(entry)}
        >
          <span className="managed-file-chevron" aria-hidden="true">
            {isDirectory
              ? <UiIcon name="chevron-right" size={13} className={isExpanded ? 'is-expanded' : undefined}/>
              : <span className="managed-file-leaf-dot">·</span>}
          </span>
          <span className="managed-file-name">{entry.name}</span>
          {entry.symlink && <span className="managed-file-meta">{t('managedFiles.symlink')}</span>}
          {entry.sensitive && <span className="managed-file-meta is-warning">{t('managedFiles.sensitive')}</span>}
          {entry.kind === 'file' && !entry.sensitive && !entry.previewable && <span className="managed-file-meta">{t('managedFiles.noPreview')}</span>}
          {!entry.accessible && <span className="managed-file-meta is-warning">{t('managedFiles.outsideRoot')}</span>}
        </button>
        {isDirectory && isExpanded && <div className="managed-file-children" data-depth={pathDepth(entry.relativePath)}>
          {loadingDirectories.has(entry.relativePath) && !directories[entry.relativePath]
            ? <div className="managed-file-loading">{t('managedFiles.loading')}</div>
            : renderDirectory(entry.relativePath)}
        </div>}
      </div>
    })
  }

  const selectedMessage = selected?.sensitive
    ? t('managedFiles.sensitiveBlocked')
    : selected && !selected.previewable
      ? t('managedFiles.previewUnavailable')
      : t('managedFiles.selectFile')

  return <Drawer
    open={open}
    className="agent-managed-files-drawer"
    title={t('managedFiles.title', { agent: productId, root: rootLabel })}
    description={rootPath}
    onClose={onClose}
  >
    <div className="managed-files-layout">
      <section className="managed-files-tree" aria-label={t('managedFiles.treeAria')}>
        <div className="managed-files-root">
          <span>{rootLabel}</span>
          <code title={rootPath}>{rootPath}</code>
        </div>
        {error && !Object.keys(directories).length
          ? <div className="managed-file-error">
              <p>{error}</p>
              <Button size="small" onClick={() => void loadDirectory('')}>{t('managedFiles.retry')}</Button>
            </div>
          : renderDirectory('')}
      </section>
      <section className="managed-file-preview" aria-label={t('managedFiles.previewAria')}>
        {selected && <div className="managed-file-preview-head">
          <div>
            <b>{selected.name}</b>
            <span>{selected.relativePath}</span>
          </div>
          {selected.size !== undefined && <small>{t('managedFiles.bytes', { count: selected.size })}</small>}
        </div>}
        {previewLoading
          ? <div className="managed-file-preview-empty">{t('managedFiles.loadingPreview')}</div>
          : preview
            ? <pre className="managed-file-preview-content"><code>{preview.content}</code></pre>
            : <div className="managed-file-preview-empty">
                <UiIcon name={selected?.sensitive ? 'alert' : 'tool-read'} size={18}/>
                <span>{selectedMessage}</span>
                {error && <small>{error}</small>}
              </div>}
      </section>
    </div>
  </Drawer>
}
