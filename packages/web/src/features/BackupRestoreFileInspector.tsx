import { useEffect, useMemo, useState } from 'react'
import { MultiFileDiff } from '@pierre/diffs/react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { BackupFilePreviewResponseDto, BackupRestorePreviewItemDto } from '@agent-lens/protocol'
import type { AgentLensApi } from '../client/api'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { ImagePreview } from '../components/ImagePreview'
import { LocalPathActions } from '../components/LocalPathActions'
import { MarkdownContent } from '../components/MarkdownContent'
import { ErrorStateBanner, OperationProgress } from '../components/StateViews'
import { Button, StatusBadge, UiIcon } from '../components/ui'

type Mode = 'diff' | 'snapshot' | 'current'
type PreviewSide = BackupFilePreviewResponseDto['snapshot']

function fileName(path: string) {
  return path.replace(/\\/g, '/').split('/').at(-1) || path
}
function previewReason(side: PreviewSide, t: TFunction): string {
  if (side.previewStatus === 'missing') return t('preview.inspectMissing')
  if (side.previewStatus === 'unavailable') return side.reason || t('preview.inspectUnavailable')
  return t(`preview.inspectBlocked.${side.blockedReason ?? 'unreadable'}`)
}

function FileBody({ side, name }: { side: PreviewSide; name: string }) {
  const { t } = useTranslation('backup')
  if (side.dataUrl) return <div className="backup-preview-inspector-image">
    <ImagePreview src={side.dataUrl} alt={name}/>
  </div>
  if (side.content !== undefined) {
    return /\.(?:md|markdown|mdown|mkd)$/i.test(name)
      ? <MarkdownContent text={side.content} frontmatter className="backup-preview-inspector-markdown"/>
      : <CopyableCodeBlock language={name.split('.').at(-1)} copyValue={side.content}>
          <code>{side.content}</code>
        </CopyableCodeBlock>
  }
  return <div className="backup-preview-inspector-unavailable">
    <UiIcon name="info" size={18}/>
    <span>{previewReason(side, t)}</span>
  </div>
}

export function BackupRestoreFileInspector({
  api, snapshotId, item, onOpenPath, onPathError,
}: {
  api: AgentLensApi
  snapshotId: string
  item: BackupRestorePreviewItemDto | null
  onOpenPath(path: string): Promise<unknown>
  onPathError(reason: unknown): void
}) {
  const { t } = useTranslation('backup')
  const [result, setResult] = useState<BackupFilePreviewResponseDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [mode, setMode] = useState<Mode>('snapshot')
  const [layout, setLayout] = useState<'unified' | 'split'>('unified')
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setTheme(root.dataset.theme === 'dark' ? 'dark' : 'light'))
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setMode(item?.status === 'modified' ? 'diff' : 'snapshot')
  }, [item?.archivePath, item?.status])
  useEffect(() => {
    if (!item) {
      setResult(null)
      setError('')
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let alive = true
    setResult(null)
    setError('')
    setLoading(true)
    void api.backupRestoreFilePreview(snapshotId, item.archivePath, controller.signal)
      .then(value => { if (alive) setResult(value) })
      .catch(reason => {
        if (alive && !(reason instanceof DOMException && reason.name === 'AbortError'))
          setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false; controller.abort() }
  }, [api, snapshotId, item?.archivePath, retry])

  const name = item ? fileName(item.targetPath || item.archivePath) : ''
  const snapshot = result?.snapshot
  const current = result?.current
  const textDiff = snapshot?.content !== undefined && current?.content !== undefined
  const imageCompare = Boolean(snapshot?.dataUrl && current?.dataUrl)
  const availableModes = useMemo<Mode[]>(() => {
    const values: Mode[] = ['snapshot']
    if (textDiff || imageCompare) values.unshift('diff')
    if (current?.previewStatus === 'readable' || current?.previewStatus === 'redacted') values.push('current')
    return values
  }, [textDiff, imageCompare, current?.previewStatus])
  const visibleMode = result && availableModes.includes(mode) ? mode : availableModes[0]!
  const diffFiles = useMemo(() => {
    if (!item || snapshot?.content === undefined || current?.content === undefined) return null
    const key = (value: string) => {
      let hash = 2166136261
      for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
      return (hash >>> 0).toString(16)
    }
    return {
      oldFile: { name, contents: snapshot.content, cacheKey: `${snapshotId}:${item.archivePath}:snapshot:${key(snapshot.content)}` },
      newFile: { name, contents: current.content, cacheKey: `${snapshotId}:${item.archivePath}:current:${key(current.content)}` },
    }
  }, [name, snapshot?.content, current?.content, snapshotId, item?.archivePath])


  return <section className="backup-preview-inspector" aria-label={t('preview.inspectTitle')}>
    {!item ? <div className="backup-preview-inspector-empty">
      <UiIcon name="file-code" size={24}/>
      <strong>{t('preview.selectFile')}</strong>
    </div> : <>
      <header className="backup-preview-inspector-header">
        <div className="backup-preview-inspector-identity">
          <strong title={name}>{name}</strong>
          <code title={item.targetPath ?? item.archivePath}>{item.targetPath || item.archivePath}</code>
        </div>
        <div className="backup-preview-inspector-actions">
          <StatusBadge tone={item.status === 'blocked' ? 'danger' : item.status === 'modified' ? 'warning' : item.status === 'unchanged' ? 'success' : 'accent'}>
            {t(`previewStatus.${item.status}`)}
          </StatusBadge>
          {result?.targetPath && <LocalPathActions path={result.targetPath} onOpen={onOpenPath} onError={onPathError}/>}
        </div>
      </header>
      {loading ? <OperationProgress title={t('preview.loadingFile')} description={name}/> :
        error ? <ErrorStateBanner message={error} onRetry={() => setRetry(value => value + 1)} showDoctor={false}/> :
        result && snapshot && current ? <>
          <div className="backup-preview-inspector-toolbar">
            <div className="backup-preview-inspector-tabs" role="group" aria-label={t('preview.inspectMode')}>
              {availableModes.map(value => <Button key={value} size="small" variant={visibleMode === value ? 'primary' : 'quiet'}
                aria-pressed={visibleMode === value} onClick={() => setMode(value)}>{t(`preview.inspectModes.${value}`)}</Button>)}
            </div>
            {visibleMode === 'diff' && textDiff && <div className="backup-preview-inspector-tabs">
              <Button size="small" variant={layout === 'unified' ? 'primary' : 'quiet'} aria-pressed={layout === 'unified'} onClick={() => setLayout('unified')}>{t('preview.diffUnified')}</Button>
              <Button size="small" variant={layout === 'split' ? 'primary' : 'quiet'} aria-pressed={layout === 'split'} onClick={() => setLayout('split')}>{t('preview.diffSplit')}</Button>
            </div>}
          </div>
          {(snapshot.redacted || current.redacted) && <p className="backup-preview-inspector-note">{t('preview.redactedNotice')}</p>}
          <div className="backup-preview-inspector-content">
            {visibleMode === 'diff' && textDiff
              ? <MultiFileDiff key={item.archivePath} oldFile={diffFiles!.oldFile}
                  newFile={diffFiles!.newFile}
                  options={{ diffStyle: layout, theme: theme === 'dark' ? 'pierre-dark' : 'pierre-light' }}/>
              : visibleMode === 'diff' && imageCompare
                ? <div className="backup-preview-inspector-image-pair">
                    <div><small>{t('preview.inspectModes.snapshot')}</small><ImagePreview src={snapshot.dataUrl!} alt={name}/></div>
                    <div><small>{t('preview.inspectModes.current')}</small><ImagePreview src={current.dataUrl!} alt={name}/></div>
                  </div>
                : <FileBody side={visibleMode === 'current' ? current : snapshot} name={name}/>}
          </div>
          {item.reason && <p className="backup-preview-inspector-note">{item.reason}</p>}
        </> : null}
    </>}
  </section>
}
