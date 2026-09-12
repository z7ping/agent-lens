import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type {
  BackupAssetKindDto,
  BackupOverviewResponseDto,
  BackupProtectionSourceDto,
  BackupRestorePreviewResponseDto,
  BackupVerifyResponseDto,
} from '@agent-lens/protocol'
import { AgentLensApi } from '../client/api'
import { agentLabel, useOrderedAgents } from '../components/AgentScope'
import { BackupDataRootTree } from '../components/BackupDirectoryTree'
import { CompactPageHeading } from '../components/CompactPageHeading'
import { PageLoadingState } from '../components/StateViews'
import { Button, Dialog, Drawer } from '../components/ui'
import { UiIcon } from '../components/UiIcon'

const RECOMMENDED_KINDS: BackupAssetKindDto[] = ['config', 'skill', 'mcp', 'plugin', 'extension', 'hook', 'rule']
const OPTIONAL_KINDS: BackupAssetKindDto[] = ['session', 'memory']
const OTHER_KINDS: BackupAssetKindDto[] = ['other']
const ALL_KINDS: BackupAssetKindDto[] = [...RECOMMENDED_KINDS, ...OPTIONAL_KINDS, ...OTHER_KINDS]

type PendingConfirmation =
  | { type: 'create' }
  | { type: 'import'; file: File }

function kindLabel(kind: BackupAssetKindDto, t: TFunction): string {
  return t(`kind.${kind === 'other' ? 'other' : kind}`)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatOptionalBytes(bytes: number | undefined, t: TFunction): string {
  return bytes === undefined ? t('sizePending') : formatBytes(bytes)
}

function formatTime(value: string, locale: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : value
}

function shortHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

function sourceDotClass(sourceId: string): string {
  if (sourceId === 'codex') return 'dot-codex'
  if (sourceId === 'claude-code') return 'dot-claude'
  if (sourceId === 'pi') return 'dot-pi'
  if (sourceId === 'hermes') return 'dot-hermes'
  if (sourceId === 'opencode') return 'dot-opencode'
  return 'dot-none'
}

function sourceLabel(sourceId: string, displayName?: string): string {
  const cleaned = displayName?.replace(/\s+Source$/i, '').trim()
  return cleaned || agentLabel(sourceId)
}

function previewStatusLabel(status: string, t: TFunction): string {
  if (status === 'unchanged') return t('previewStatus.unchanged')
  if (status === 'missing') return t('previewStatus.missing')
  if (status === 'modified') return t('previewStatus.modified')
  return t('previewStatus.blocked')
}

function kindFiles(source: BackupProtectionSourceDto, kind: BackupAssetKindDto): number {
  return source.kindDetails?.[kind]?.fileCount ?? source.kinds[kind] ?? 0
}

function kindLogicalAssets(source: BackupProtectionSourceDto, kind: BackupAssetKindDto): number | undefined {
  return source.kindDetails?.[kind]?.logicalAssetCount
}

function kindBytes(source: BackupProtectionSourceDto, kind: BackupAssetKindDto): number | undefined {
  return source.kindDetails?.[kind]?.totalBytes
}

function kindDetailText(
  source: BackupProtectionSourceDto,
  kind: BackupAssetKindDto,
  t: TFunction,
  locale: string,
): string {
  const files = kindFiles(source, kind)
  const logical = kindLogicalAssets(source, kind)
  return logical === undefined
    ? t('files', { count: files.toLocaleString(locale) })
    : t('logicalFiles', { logical: logical.toLocaleString(locale), files: files.toLocaleString(locale) })
}

function sumKindFiles(sources: BackupProtectionSourceDto[], sourceIds: string[], kind: BackupAssetKindDto): number {
  return sources
    .filter(source => sourceIds.includes(source.sourceId))
    .reduce((sum, source) => sum + kindFiles(source, kind), 0)
}

function sumKindLogicalAssets(sources: BackupProtectionSourceDto[], sourceIds: string[], kind: BackupAssetKindDto): number | undefined {
  const selected = sources.filter(source => sourceIds.includes(source.sourceId))
  const values = selected.map(source => kindLogicalAssets(source, kind)).filter((value): value is number => value !== undefined)
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined
}

function policyKinds(kindGroup: BackupAssetKindDto[], sources: BackupProtectionSourceDto[], sourceIds: string[]): BackupAssetKindDto[] {
  return kindGroup.filter(kind => sumKindFiles(sources, sourceIds, kind) > 0)
}

export function BackupPage({
  selectedAssetSourceId,
  onSelectedAssetSourceIdChange,
}: {
  selectedAssetSourceId: string
  onSelectedAssetSourceIdChange(sourceId: string): void
}) {
  const { t, i18n } = useTranslation('backup')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const api = useMemo(() => new AgentLensApi(), [])
  const [overview, setOverview] = useState<BackupOverviewResponseDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[] | null>(null)
  const [selectedKinds, setSelectedKinds] = useState<BackupAssetKindDto[]>(RECOMMENDED_KINDS)
  const [createOpen, setCreateOpen] = useState(false)
  const [verification, setVerification] = useState<Record<string, BackupVerifyResponseDto>>({})
  const [preview, setPreview] = useState<BackupRestorePreviewResponseDto | null>(null)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const importInput = useRef<HTMLInputElement>(null)

  const applyOverview = (next: BackupOverviewResponseDto) => {
    setOverview(next)
  }

  const refresh = async (force = false) => {
    setLoading(true)
    setError('')
    try {
      applyOverview(force ? await api.refreshBackupOverview() : await api.backupOverview())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (!overview?.index?.refreshing) return
    let disposed = false
    const timer = window.setInterval(() => {
      void api.backupOverview().then(next => {
        if (disposed) return
        applyOverview(next)
        if (next.index?.refreshing === false) window.clearInterval(timer)
      }).catch(reason => {
        if (disposed) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
    }, 1500)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [api, overview?.index?.refreshing])
  useEffect(() => {
    if (!success) return
    const timer = window.setTimeout(() => setSuccess(''), 7000)
    return () => window.clearTimeout(timer)
  }, [success])

  const sources = useOrderedAgents(overview?.sources ?? [])
  const detectedSources = sources.filter(source => source.detected)
  const detectedSourceIds = detectedSources.map(source => source.sourceId)
  const selectedSources = selectedSourceIds ?? detectedSourceIds
  const visibleAssetSources = selectedAssetSourceId
    ? detectedSources.filter(source => source.sourceId === selectedAssetSourceId)
    : detectedSources
  const focusedSource = selectedAssetSourceId ? visibleAssetSources[0] ?? null : null
  const snapshots = overview?.snapshots ?? []
  const protectedFiles = visibleAssetSources.reduce((sum, source) => sum + source.fileCount, 0)
  const protectedBytes = visibleAssetSources.reduce((sum, source) => sum + (source.totalBytes ?? 0), 0)
  const hasProtectedBytes = visibleAssetSources.some(source => source.totalBytes !== undefined)
  const excludedFiles = visibleAssetSources.reduce((sum, source) => sum + source.excludedCount, 0)
  const estimatedSelected = sources
    .filter(source => selectedSources.includes(source.sourceId))
    .reduce((sum, source) => sum + selectedKinds.reduce((kindSum, kind) => kindSum + kindFiles(source, kind), 0), 0)
  const estimatedSelectedBytes = sources
    .filter(source => selectedSources.includes(source.sourceId))
    .reduce((sum, source) => sum + selectedKinds.reduce((kindSum, kind) => kindSum + (kindBytes(source, kind) ?? 0), 0), 0)
  const hasSelectedBytes = sources
    .filter(source => selectedSources.includes(source.sourceId))
    .some(source => selectedKinds.some(kind => kindBytes(source, kind) !== undefined))

  const toggleSource = (sourceId: string) => {
    const current = selectedSourceIds ?? detectedSourceIds
    setSelectedSourceIds(current.includes(sourceId)
      ? current.filter(item => item !== sourceId)
      : [...current, sourceId])
  }

  const toggleKind = (kind: BackupAssetKindDto) => {
    setSelectedKinds(current => current.includes(kind)
      ? current.filter(item => item !== kind)
      : [...current, kind])
  }

  const openCreateSnapshot = () => {
    setSelectedSourceIds(selectedAssetSourceId ? [selectedAssetSourceId] : null)
    setCreateOpen(true)
  }

  const requestCreateSnapshot = () => {
    if (!selectedSources.length || !selectedKinds.length || busy) return
    setSuccess('')
    setConfirmation({ type: 'create' })
  }

  const createSnapshot = async () => {
    if (!selectedSources.length || !selectedKinds.length || busy) return
    setBusy('create')
    setError('')
    setSuccess('')
    try {
      const result = await api.createBackup({ sourceIds: selectedSources, kinds: selectedKinds })
      const bytes = result.snapshot.files.reduce((sum, file) => sum + file.size, 0)
      const excluded = result.snapshot.excluded.length
      setSuccess(t('snapshotCreated', {
        files: result.snapshot.files.length.toLocaleString(locale),
        size: formatBytes(bytes),
        excluded: excluded ? t('snapshotExcluded', { count: excluded.toLocaleString(locale) }) : '',
      }))
      await refresh()
      setCreateOpen(false)
    } catch (reason) {
      setSuccess('')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const verifySnapshot = async (id: string) => {
    if (busy) return
    setBusy(`verify:${id}`)
    setError('')
    try {
      const result = await api.verifyBackup(id)
      setVerification(current => ({ ...current, [id]: result }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const verifyAll = async () => {
    if (busy) return
    setBusy('verify-all')
    setError('')
    try {
      const results: Record<string, BackupVerifyResponseDto> = {}
      for (const snapshot of snapshots) results[snapshot.id] = await api.verifyBackup(snapshot.id)
      setVerification(current => ({ ...current, ...results }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const exportSnapshot = async (id: string) => {
    if (busy) return
    setBusy(`export:${id}`)
    setError('')
    try {
      const blob = await api.exportBackup(id)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${id}.agentlens-backup`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const showRestorePreview = async (id: string) => {
    if (busy) return
    setBusy(`preview:${id}`)
    setError('')
    try {
      setPreview(await api.backupRestorePreview(id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const selectImportBackup = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busy) return
    setConfirmation({ type: 'import', file })
  }

  const importBackup = async (file: File) => {
    if (busy) return
    setBusy('import')
    setError('')
    try {
      await api.importBackup(file)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const confirmCriticalOperation = async () => {
    if (!confirmation || busy) return
    const pending = confirmation
    setConfirmation(null)
    if (pending.type === 'create') await createSnapshot()
    else await importBackup(pending.file)
  }

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
    } catch {
      setError(t('copyPathFailed'))
    }
  }

  if (!overview || overview.index?.ready === false) return <PageLoadingState
    eyebrow={t('loading.eyebrow')}
    statusLabel={t('loading.status')}
    title={t('loading.title')}
    description={t('loading.description')}
    facts={[t('loading.factOrdered'), t('loading.factReadonly'), t('loading.factProgressive')]}
  />

  const indexTime = overview.index?.generatedAt
  const indexRefreshing = overview.index?.refreshing ?? false
  const refreshing = loading || indexRefreshing
  const detectedSourceCount = detectedSourceIds.length
  const recommendedVisible = policyKinds(RECOMMENDED_KINDS, sources, selectedSources)
  const optionalVisible = policyKinds(OPTIONAL_KINDS, sources, selectedSources)
  const otherVisible = policyKinds(OTHER_KINDS, sources, selectedSources)

  const renderKindCheck = (kind: BackupAssetKindDto) => {
    const files = sumKindFiles(sources, selectedSources, kind)
    const logical = sumKindLogicalAssets(sources, selectedSources, kind)
    return <label key={kind} className="builder-check">
      <input type="checkbox" checked={selectedKinds.includes(kind)} onChange={() => toggleKind(kind)}/>
      {kindLabel(kind, t)}
      <small>{logical === undefined
        ? t('builder.files', { count: files.toLocaleString(locale) })
        : t('builder.logicalFiles', { logical: logical.toLocaleString(locale), files: files.toLocaleString(locale) })}</small>
    </label>
  }

  return <>
    <div className="page-scroll">
      <main className="future-content backup-page">
        <input ref={importInput} className="backup-file-input" type="file" accept=".agentlens-backup,application/vnd.agentlens.backup" onChange={selectImportBackup}/>

        <div className="future-heading">
          <CompactPageHeading title={t('page.title')} description={t('page.description')}><span className="prototype-flag live">{t('page.liveData')}</span></CompactPageHeading>
          <div className="backup-heading-actions">
            <Button disabled={Boolean(busy)} onClick={() => importInput.current?.click()}><UiIcon name="upload" size={14}/>{t('toolbar.import')}</Button>
            <Button variant="primary" disabled={Boolean(busy)} onClick={openCreateSnapshot}><UiIcon name="plus" size={14}/>{t('toolbar.create')}</Button>
            <Button loading={refreshing} disabled={refreshing || Boolean(busy)} onClick={() => void refresh(true)}><UiIcon name="refresh" size={14}/>{t('page.refresh')}</Button>
          </div>
        </div>

        {error && <div className="backup-error" role="alert"><b>{t('page.operationFailed')}</b><span>{error}</span><button className="link-btn" onClick={() => setError('')}>{t('page.close')}</button></div>}
        {success && <div className="future-note" role="status"><b>{t('page.operationDone')}</b> · {success}</div>}

        <section className="backup-overview-strip" aria-label={t('assetView.overviewAria')}>
          <div className="backup-overview-primary">
            <b>{focusedSource ? sourceLabel(focusedSource.sourceId, focusedSource.displayName) : t('assetView.allAgents')}</b>
            <span>{t('assetView.overview', {
              agents: visibleAssetSources.length.toLocaleString(locale),
              files: protectedFiles.toLocaleString(locale),
              size: hasProtectedBytes ? formatBytes(protectedBytes) : t('sizePending'),
            })}</span>
          </div>
          <div className="backup-overview-secondary">
            <span>{indexTime ? t('assetView.index', { time: formatTime(indexTime, locale) }) : t('protection.indexPreparing')}</span>
            <span>{t('assetView.excluded', { count: excludedFiles.toLocaleString(locale) })}</span>
            <span className={`badge ${indexRefreshing ? 'info' : 'ok'}`}>{indexRefreshing ? t('kpi.updating') : t('kpi.ready')}</span>
          </div>
        </section>

        <section className="backup-assets-section">
          <div className="backup-section-head">
            <div>
              <h2>{focusedSource ? t('assetView.agentAssets') : t('assetView.currentAssets')}</h2>
              <span>{focusedSource ? t('assetView.singleHint') : t('assetView.allHint')}</span>
            </div>
          </div>

          {!visibleAssetSources.length && <div className="backup-assets-empty">{t('assetView.noAssets')}</div>}

          {!focusedSource && visibleAssetSources.map(source => {
            const kinds = ALL_KINDS.filter(kind => kindFiles(source, kind) > 0)
            const primaryRoot = source.roots?.[0]
            return <article key={source.sourceId} className="backup-agent-asset-summary">
              <div className="backup-agent-asset-head">
                <div className="backup-agent-title">
                  <span className={`src-dot lg ${sourceDotClass(source.sourceId)}`}/>
                  <span><b>{sourceLabel(source.sourceId, source.displayName)}</b><small>{t('assetView.sourceScale', {
                    files: source.fileCount.toLocaleString(locale),
                    size: source.totalBytes === undefined ? t('sizePending') : formatBytes(source.totalBytes),
                  })}</small></span>
                </div>
                <button className="link-btn" onClick={() => onSelectedAssetSourceIdChange(source.sourceId)}>{t('assetView.viewDetails')}</button>
              </div>
              <div className="backup-agent-kind-facts">
                {kinds.map(kind => {
                  const logical = kindLogicalAssets(source, kind)
                  const files = kindFiles(source, kind)
                  return <span key={kind}><b>{kindLabel(kind, t)}</b><span>{logical === undefined ? t('assetView.filesShort', { count: files.toLocaleString(locale) }) : t('assetView.itemsShort', { count: logical.toLocaleString(locale) })}</span></span>
                })}
              </div>
              <div className="backup-agent-asset-foot">
                <code title={primaryRoot?.path}>{primaryRoot?.path ?? t('assetView.locationPending')}</code>
                {source.roots && source.roots.length > 1 && <span>{t('assetView.moreLocations', { count: source.roots.length - 1 })}</span>}
                {source.latestModifiedAt && <span>{t('assetView.latest', { time: formatTime(source.latestModifiedAt, locale) })}</span>}
              </div>
            </article>
          })}

          {focusedSource && <div className="backup-agent-detail">
            <section className="backup-agent-detail-summary">
              <div className="backup-agent-title">
                <span className={`src-dot lg ${sourceDotClass(focusedSource.sourceId)}`}/>
                <span><b>{sourceLabel(focusedSource.sourceId, focusedSource.displayName)}</b><small>{t('assetView.sourceScale', {
                  files: focusedSource.fileCount.toLocaleString(locale),
                  size: formatOptionalBytes(focusedSource.totalBytes, t),
                })}</small></span>
              </div>
              <div className="backup-agent-detail-facts">
                <span><b>{focusedSource.logicalAssetCount === undefined ? '—' : focusedSource.logicalAssetCount.toLocaleString(locale)}</b>{t('detail.logicalAssets')}</span>
                <span><b>{focusedSource.fileCount.toLocaleString(locale)}</b>{t('detail.physicalFiles')}</span>
                <span><b>{formatOptionalBytes(focusedSource.totalBytes, t)}</b>{t('detail.dataSize')}</span>
                <span><b>{focusedSource.excludedCount.toLocaleString(locale)}</b>{t('detail.scanExcluded')}</span>
              </div>
            </section>

            <section className="backup-agent-detail-section">
              <div className="backup-section-head"><div><h3>{t('detail.categories')}</h3></div></div>
              <div className="backup-asset-kind-list">
                {ALL_KINDS.filter(kind => kindFiles(focusedSource, kind) > 0).map(kind => <div key={kind} className="backup-asset-kind-row">
                  <b>{kindLabel(kind, t)}</b>
                  <span>{kindDetailText(focusedSource, kind, t, locale)}</span>
                  <span>{kindBytes(focusedSource, kind) === undefined ? '—' : formatBytes(kindBytes(focusedSource, kind)!)}</span>
                </div>)}
              </div>
            </section>

            <section className="backup-agent-detail-section">
              <div className="backup-section-head"><div><h3>{t('detail.locations')}</h3></div></div>
              {focusedSource.roots?.length
                ? <div className="backup-location-list">{focusedSource.roots.map(root => <BackupDataRootTree key={`${root.scope}:${root.path}`} root={root} onCopy={path => void copyPath(path)}/>)}</div>
                : <div className="backup-assets-empty">{t('detail.locationsPending')}</div>}
            </section>

            {(focusedSource.oldestModifiedAt || focusedSource.latestModifiedAt || focusedSource.ageBuckets) && <section className="backup-agent-detail-section">
              <div className="backup-section-head"><div><h3>{t('detail.timeDistribution')}</h3></div></div>
              {(focusedSource.oldestModifiedAt || focusedSource.latestModifiedAt) && <div className="backup-time-range">
                <span>{t('detail.oldest', { time: focusedSource.oldestModifiedAt ? formatTime(focusedSource.oldestModifiedAt, locale) : '—' })}</span>
                <span>{t('detail.latest', { time: focusedSource.latestModifiedAt ? formatTime(focusedSource.latestModifiedAt, locale) : '—' })}</span>
              </div>}
              {focusedSource.ageBuckets && <div className="backup-age-facts">
                <span><b>{focusedSource.ageBuckets.recent30Days.fileCount.toLocaleString(locale)}</b>{t('detail.recent30')}</span>
                <span><b>{focusedSource.ageBuckets.days31To90.fileCount.toLocaleString(locale)}</b>{t('detail.days31To90')}</span>
                <span><b>{focusedSource.ageBuckets.days91To180.fileCount.toLocaleString(locale)}</b>{t('detail.days91To180')}</span>
                <span><b>{focusedSource.ageBuckets.olderThan180Days.fileCount.toLocaleString(locale)}</b>{t('detail.older180')}</span>
              </div>}
            </section>}
          </div>}
        </section>

        <section className="backup-history-section">
          <div className="backup-section-head">
            <div><h2>{t('assetView.historyTitle')}</h2><span>{t('assetView.historyHint')}</span></div>
            {snapshots.length > 0 && <Button size="small" loading={busy === 'verify-all'} disabled={Boolean(busy)} onClick={() => void verifyAll()}>{t('snapshots.verifyAll')}</Button>}
          </div>
          {snapshots.length ? <div className="backup-snapshot-list">
            {snapshots.map(snapshot => {
              const checked = verification[snapshot.id]
              return <article key={snapshot.id} className="backup-snapshot-row">
                <div className="backup-snapshot-main">
                  <span className="snapshot-icon">{checked ? (checked.valid ? <UiIcon name="check" size={14}/> : <UiIcon name="alert" size={14}/>) : <UiIcon name="dot" size={14}/>}</span>
                  <span><b>{formatTime(snapshot.createdAt, locale)}</b><small>{snapshot.sourceIds.map(sourceId => sourceLabel(sourceId)).join(' · ') || '—'}</small><small className="backup-snapshot-meta">{t('snapshots.rowMeta', { files: snapshot.fileCount.toLocaleString(locale), excluded: snapshot.excludedCount.toLocaleString(locale), hash: shortHash(snapshot.manifestSha256) })}</small></span>
                </div>
                <div className="backup-snapshot-state"><strong>{formatBytes(snapshot.totalBytes)}</strong>{checked ? <span className={`badge ${checked.valid ? 'ok' : 'err'}`}>{checked.valid ? t('snapshots.verifyPassed') : t('snapshots.verifyFailed')}</span> : <span className="badge">{t('snapshots.unverified')}</span>}</div>
                <div className="table-actions"><button className="link-btn" disabled={Boolean(busy)} onClick={() => void verifySnapshot(snapshot.id)}>{t('snapshots.verify')}</button><button className="link-btn" disabled={Boolean(busy)} onClick={() => void showRestorePreview(snapshot.id)}>{t('snapshots.preview')}</button><button className="link-btn" disabled={Boolean(busy)} onClick={() => void exportSnapshot(snapshot.id)}>{t('snapshots.export')}</button></div>
              </article>
            })}
          </div> : <div className="backup-history-empty">{t('assetView.noHistory')}</div>}
        </section>
      </main>
    </div>

    {createOpen && <Drawer
      open
      className="backup-create-drawer"
      title={t('create.title')}
      description={t('create.description')}
      onClose={() => { if (!busy) setCreateOpen(false) }}
      closeDisabled={Boolean(busy)}
      closeOnBackdrop={!busy}
      footer={<div className="backup-create-footer">
        <div><span>{t('create.estimate', { count: estimatedSelected.toLocaleString(locale) })}</span><b>{hasSelectedBytes ? t('create.estimateSize', { size: formatBytes(estimatedSelectedBytes) }) : t('create.sizePending')}</b></div>
        <Button variant="primary" loading={busy === 'create'} disabled={Boolean(busy) || !selectedSources.length || !selectedKinds.length} onClick={requestCreateSnapshot}>{t('create.createAndVerify')}</Button>
      </div>}
    >
      <div className="snapshot-builder">
        <div className="builder-block backup-agent-block">
          <div className="builder-label"><span>{t('create.agents')}</span><span>{selectedSources.length} / {detectedSourceCount}</span></div>
          <div className="backup-source-list">
            {sources.filter(source => source.detected).map(source => <div key={source.sourceId} className="backup-source-choice">
              <label className="backup-source-toggle">
                <input type="checkbox" checked={selectedSources.includes(source.sourceId)} onChange={() => toggleSource(source.sourceId)}/>
                <span className={`src-dot ${sourceDotClass(source.sourceId)}`}/>
                <span className="backup-source-copy"><b>{sourceLabel(source.sourceId, source.displayName)}</b><small>{source.totalBytes === undefined ? t('create.files', { count: source.fileCount.toLocaleString(locale) }) : t('create.sourceSummary', { count: source.fileCount.toLocaleString(locale), size: formatBytes(source.totalBytes) })}</small></span>
              </label>
              <button className="link-btn" onClick={() => { setCreateOpen(false); onSelectedAssetSourceIdChange(source.sourceId) }}>{t('assetView.viewAssets')}</button>
            </div>)}
          </div>
        </div>

        {recommendedVisible.length > 0 && <div className="builder-block"><div className="builder-label"><span>{t('create.contents')}</span><span className="badge ok">{t('create.recommended')}</span></div><div className="builder-checks">{recommendedVisible.map(renderKindCheck)}</div></div>}
        {optionalVisible.length > 0 && <div className="builder-block"><div className="builder-label"><span>{t('create.optional')}</span></div><div className="builder-checks">{optionalVisible.map(renderKindCheck)}</div></div>}
        {otherVisible.length > 0 && <div className="builder-block"><div className="builder-label"><span>{t('create.more')}</span></div><div className="builder-checks">{otherVisible.map(renderKindCheck)}</div></div>}

        <div className="backup-safety-line"><UiIcon name="check" size={14}/><span>{t('create.safetyCompact', { count: excludedFiles.toLocaleString(locale) })}</span></div>
      </div>
    </Drawer>}

    {preview && <Drawer
      open
      className="backup-preview-drawer"
      title={<span className="backup-overlay-title">{t('preview.title')} <span className={`badge ${preview.blocked ? 'warn' : 'ok'}`}>{preview.blocked ? t('preview.blocked', { count: preview.blocked }) : t('preview.passed')}</span></span>}
      description={preview.snapshotId}
      onClose={() => { if (!busy) setPreview(null) }}
      closeDisabled={Boolean(busy)}
      closeOnBackdrop={!busy}
    >
      <div className="future-drawer-body">
        <section className="drawer-section"><h3>{t('preview.summary')}</h3><div className="preview-summary"><span><b>{preview.unchanged}</b> {t('preview.unchanged')}</span><span><b>{preview.missing}</b> {t('preview.missing')}</span><span><b>{preview.modified}</b> {t('preview.modified')}</span><span><b>{preview.blocked}</b> {t('preview.blockedLabel')}</span></div></section>
        <section className="drawer-section"><h3>{t('preview.files')}</h3><div className="drawer-file-list">{preview.items.map(item => <div key={`${item.sourceId}:${item.archivePath}`} className="drawer-file preview-file"><span className={`badge ${item.status === 'blocked' ? 'err' : item.status === 'modified' ? 'warn' : item.status === 'unchanged' ? 'ok' : 'info'}`}>{previewStatusLabel(item.status, t)}</span><code>{item.targetPath ?? item.archivePath}</code>{item.reason && <small>{item.reason}</small>}</div>)}</div></section>
        <section className="drawer-section"><div className="future-note"><b>{t('preview.noteTitle')}</b> {t('preview.noteDescription')}</div></section>
      </div>
    </Drawer>}

    {confirmation && <Dialog
      open
      className="backup-confirm-overlay"
      title={confirmation.type === 'create' ? t('confirm.createTitle') : t('confirm.importTitle')}
      onClose={() => { if (!busy) setConfirmation(null) }}
      closeDisabled={Boolean(busy)}
      closeOnBackdrop={!busy}
      footer={<>
        <Button disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>{t('confirm.cancel')}</Button>
        <Button variant="primary" disabled={Boolean(busy)} onClick={() => void confirmCriticalOperation()}>{confirmation.type === 'create' ? t('confirm.create') : t('confirm.import')}</Button>
      </>}
    >
      <div className="backup-confirm-content">
        <div className="backup-confirm-icon"><UiIcon name="alert" size={20}/></div>
        <div className="backup-confirm-copy">
          {confirmation.type === 'create'
            ? <p>{t('confirm.createBody', { agents: selectedSources.length, kinds: selectedKinds.length })}</p>
            : <p>{t('confirm.importBody', { file: confirmation.file.name, size: formatBytes(confirmation.file.size) })}</p>}
          <div className="backup-confirm-facts">
            {confirmation.type === 'create'
              ? <><span>{t('confirm.estimate', { count: estimatedSelected.toLocaleString(locale) })}</span><span>{hasSelectedBytes ? t('create.estimateSize', { size: formatBytes(estimatedSelectedBytes) }) : t('protection.index', { time: indexTime ? formatTime(indexTime, locale) : t('confirm.indexPreparing') })}</span></>
              : <><span>{t('confirm.importVaultOnly')}</span><span>{t('confirm.restoreNeedsPreview')}</span></>}
          </div>
        </div>
      </div>
    </Dialog>}
  </>
}
