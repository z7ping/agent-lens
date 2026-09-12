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
import { Button, Dialog, Drawer, Toolbar, ToolbarGroup } from '../components/ui'
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

function kindRecommendation(kind: BackupAssetKindDto, t: TFunction): string {
  if (RECOMMENDED_KINDS.includes(kind)) return t('recommendation.recommended')
  if (OPTIONAL_KINDS.includes(kind)) return t('recommendation.optional')
  return t('recommendation.excluded')
}

function recommendationTone(kind: BackupAssetKindDto): string {
  if (RECOMMENDED_KINDS.includes(kind)) return 'ok'
  if (OPTIONAL_KINDS.includes(kind)) return 'info'
  return ''
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
  selectedSourceIds,
  onSelectedSourceIdsChange,
}: {
  selectedSourceIds: string[] | null
  onSelectedSourceIdsChange(sourceIds: string[] | null): void
}) {
  const { t, i18n } = useTranslation('backup')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const api = useMemo(() => new AgentLensApi(), [])
  const [overview, setOverview] = useState<BackupOverviewResponseDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [selectedKinds, setSelectedKinds] = useState<BackupAssetKindDto[]>(RECOMMENDED_KINDS)
  const [verification, setVerification] = useState<Record<string, BackupVerifyResponseDto>>({})
  const [preview, setPreview] = useState<BackupRestorePreviewResponseDto | null>(null)
  const [detailSourceId, setDetailSourceId] = useState<string | null>(null)
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
  const detectedSourceIds = sources.filter(source => source.detected).map(source => source.sourceId)
  const selectedSources = selectedSourceIds ?? detectedSourceIds
  const snapshots = overview?.snapshots ?? []
  const protectedFiles = sources.reduce((sum, source) => sum + source.fileCount, 0)
  const protectedBytes = sources.reduce((sum, source) => sum + (source.totalBytes ?? 0), 0)
  const hasProtectedBytes = sources.some(source => source.totalBytes !== undefined)
  const excludedFiles = sources.reduce((sum, source) => sum + source.excludedCount, 0)
  const totalSnapshotBytes = snapshots.reduce((sum, snapshot) => sum + snapshot.totalBytes, 0)
  const estimatedSelected = sources
    .filter(source => selectedSources.includes(source.sourceId))
    .reduce((sum, source) => sum + selectedKinds.reduce((kindSum, kind) => kindSum + kindFiles(source, kind), 0), 0)
  const estimatedSelectedBytes = sources
    .filter(source => selectedSources.includes(source.sourceId))
    .reduce((sum, source) => sum + selectedKinds.reduce((kindSum, kind) => kindSum + (kindBytes(source, kind) ?? 0), 0), 0)
  const hasSelectedBytes = sources
    .filter(source => selectedSources.includes(source.sourceId))
    .some(source => selectedKinds.some(kind => kindBytes(source, kind) !== undefined))
  const detailSource = sources.find(source => source.sourceId === detailSourceId) ?? null

  const toggleSource = (sourceId: string) => {
    const current = selectedSourceIds ?? detectedSourceIds
    onSelectedSourceIdsChange(current.includes(sourceId)
      ? current.filter(item => item !== sourceId)
      : [...current, sourceId])
  }

  const toggleKind = (kind: BackupAssetKindDto) => {
    setSelectedKinds(current => current.includes(kind)
      ? current.filter(item => item !== kind)
      : [...current, kind])
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
    <Toolbar className="workspace-toolbar" aria-label={t('toolbar.aria')}>
      <ToolbarGroup><span className="backup-toolbar-note">{t('toolbar.safety')}</span></ToolbarGroup>
      <ToolbarGroup align="end">
        <Button loading={busy === 'import'} disabled={Boolean(busy)} onClick={() => importInput.current?.click()}><UiIcon name="upload" size={14}/>{t('toolbar.import')}</Button>
        <Button variant="primary" loading={busy === 'create'} disabled={Boolean(busy) || !selectedSources.length || !selectedKinds.length} onClick={requestCreateSnapshot}><UiIcon name="plus" size={14}/>{t('toolbar.create')}</Button>
      </ToolbarGroup>
      <input ref={importInput} className="backup-file-input" type="file" accept=".agentlens-backup,application/vnd.agentlens.backup" onChange={selectImportBackup}/>
    </Toolbar>

    <div className="page-scroll">
      <main className="future-content backup-page">
        <div className="future-heading">
          <CompactPageHeading title={t('page.title')} description={t('page.description')}><span className="prototype-flag live">{t('page.liveData')}</span></CompactPageHeading>
          <Button loading={refreshing} disabled={refreshing || Boolean(busy)} onClick={() => void refresh(true)}><UiIcon name="refresh" size={14}/>{t('page.refresh')}</Button>
        </div>

        {error && <div className="backup-error" role="alert"><b>{t('page.operationFailed')}</b><span>{error}</span><button className="link-btn" onClick={() => setError('')}>{t('page.close')}</button></div>}
        {success && <div className="future-note" role="status"><b>{t('page.operationDone')}</b> · {success}</div>}

        <section className="future-kpis" aria-label={t('kpi.aria')}>
          <article className="future-kpi"><div className="future-kpi-head"><span>{t('kpi.physicalFiles')}</span><span className={`badge ${indexRefreshing ? 'info' : 'ok'}`}>{indexRefreshing ? t('kpi.updating') : t('kpi.ready')}</span></div><strong>{protectedFiles.toLocaleString()}</strong><small>{hasProtectedBytes ? `${formatBytes(protectedBytes)} · ` : ''}{indexTime ? t('kpi.indexUpdated', { time: formatTime(indexTime, locale) }) : ''}{t('kpi.agents', { count: detectedSourceCount })}</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>{t('kpi.snapshots')}</span><span className="delta neutral">{snapshots[0] ? t('kpi.recent', { time: formatTime(snapshots[0].createdAt, locale) }) : t('kpi.noSnapshot')}</span></div><strong>{snapshots.length}</strong><small>{t('kpi.logicalSize', { size: formatBytes(totalSnapshotBytes) })}</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>{t('kpi.lastVerify')}</span><span className={`badge ${Object.values(verification).some(result => !result.valid) ? 'err' : Object.keys(verification).length ? 'ok' : ''}`}>{Object.keys(verification).length ? (Object.values(verification).every(result => result.valid) ? t('kpi.passed') : t('kpi.attention')) : t('kpi.notRun')}</span></div><strong>{Object.values(verification).filter(result => result.valid).length}/{Object.keys(verification).length || '—'}</strong><small>{t('kpi.verifyDescription')}</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>{t('kpi.excluded')}</span><span className="badge warn">{t('kpi.safetyFirst')}</span></div><strong>{excludedFiles.toLocaleString()}</strong><small>{t('kpi.excludedDescription')}</small></article>
        </section>

        <div className="future-grid">
          <div className="future-stack">
            <section className="future-card">
              <div className="future-card-head"><div><h2>{t('protection.title')}</h2><p>{t('protection.description')}</p></div></div>
              <div className="future-card-body">
                <div className="protection-grid">
                  {sources.map(source => <article key={source.sourceId} className={`protection-card ${!source.detected ? 'is-muted' : ''}`}>
                    <div className="protection-card-head"><span className={`src-dot lg ${sourceDotClass(source.sourceId)}`}/><b>{sourceLabel(source.sourceId, source.displayName)}</b><span className={`badge ${source.detected ? 'ok' : ''}`}>{source.detected ? t('protection.detected') : t('protection.notDetected')}</span></div>
                    <div className="protection-counts">
                      <div className="protection-count"><strong>{source.logicalAssetCount === undefined ? '—' : source.logicalAssetCount.toLocaleString()}</strong><span>{t('protection.logicalAssets')}</span></div>
                      <div className="protection-count"><strong>{source.fileCount.toLocaleString()}</strong><span>{t('protection.physicalFiles')}</span></div>
                      <div className="protection-count"><strong>{source.totalBytes === undefined ? '—' : formatBytes(source.totalBytes)}</strong><span>{t('protection.dataSize')}</span></div>
                    </div>
                    <div className="protection-meta"><span>{t('protection.mcpSession', {
                        mcp: kindDetailText(source, 'mcp', t, locale),
                        sessions: kindFiles(source, 'session').toLocaleString(locale),
                      })}</span><button className="link-btn" disabled={!source.detected} onClick={() => setDetailSourceId(source.sourceId)}>{t('protection.details')}</button></div>
                  </article>)}
                </div>
                <div className="future-section-label">{t('protection.currentDirectory')}</div>
                <div className="integrity-strip"><strong>{t('protection.localVault')}</strong><code>{overview?.vaultPath ?? '—'}</code><span className="grow"/><span>{indexTime ? t('protection.index', { time: formatTime(indexTime, locale) }) : t('protection.indexPreparing')} · {t('protection.noCanonicalWrite')}</span></div>
              </div>
            </section>

            <section className="future-card">
              <div className="future-card-head"><div><h2>{t('snapshots.title')}</h2><p>{t('snapshots.description')}</p></div><Button size="small" loading={busy === 'verify-all'} disabled={Boolean(busy) || !snapshots.length} onClick={() => void verifyAll()}>{t('snapshots.verifyAll')}</Button></div>
              {snapshots.length ? <div className="future-table-scroll"><table className="snapshot-table"><thead><tr><th>{t('snapshots.snapshot')}</th><th>{t('snapshots.source')}</th><th>{t('snapshots.size')}</th><th>{t('snapshots.integrity')}</th><th>{t('snapshots.excluded')}</th><th>{t('snapshots.hash')}</th><th className="align-right">{t('snapshots.actions')}</th></tr></thead><tbody>
                {snapshots.map(snapshot => {
                  const checked = verification[snapshot.id]
                  return <tr key={snapshot.id}>
                    <td><div className="snapshot-name"><span className="snapshot-icon">{checked ? (checked.valid ? <UiIcon name="check" size={14}/> : <UiIcon name="alert" size={14}/>) : <UiIcon name="dot" size={14}/>}</span><span><b>{formatTime(snapshot.createdAt, locale)}</b><small>{t('snapshots.files', { count: snapshot.fileCount })}</small></span></div></td>
                    <td>{snapshot.sourceIds.map(sourceId => sourceLabel(sourceId)).join(' · ') || '—'}</td>
                    <td>{formatBytes(snapshot.totalBytes)}</td>
                    <td>{checked ? <span className={`badge ${checked.valid ? 'ok' : 'err'}`}>{checked.valid ? t('snapshots.verifyPassed') : t('snapshots.verifyFailed')}</span> : <span className="badge">{t('snapshots.unverified')}</span>}</td>
                    <td>{snapshot.excludedCount}</td>
                    <td><span className="hash">{shortHash(snapshot.manifestSha256)}</span></td>
                    <td><div className="table-actions"><button className="link-btn" disabled={Boolean(busy)} onClick={() => void verifySnapshot(snapshot.id)}>{t('snapshots.verify')}</button><button className="link-btn" disabled={Boolean(busy)} onClick={() => void showRestorePreview(snapshot.id)}>{t('snapshots.preview')}</button><button className="link-btn" disabled={Boolean(busy)} onClick={() => void exportSnapshot(snapshot.id)}>{t('snapshots.export')}</button></div></td>
                  </tr>
                })}
              </tbody></table></div> : <div className="backup-empty"><b>{t('snapshots.emptyTitle')}</b><span>{t('snapshots.emptyDescription')}</span></div>}
            </section>

            <section className="future-card">
              <div className="future-card-head"><div><h2>{t('restore.title')}</h2><p>{t('restore.description')}</p></div><span className="badge info">{t('restore.previewFirst')}</span></div>
              <div className="future-card-body"><div className="restore-grid">
                <article className="restore-card"><h3>{t('restore.importTitle')}</h3><p>{t('restore.importDescription')}</p><div className="restore-flow"><span className="restore-node">{t('restore.selectFile')}</span><span className="restore-arrow"><UiIcon name="arrow-right" size={12}/></span><span className="restore-node">{t('restore.secondConfirm')}</span><span className="restore-arrow"><UiIcon name="arrow-right" size={12}/></span><span className="restore-node">{t('restore.integrityCheck')}</span></div><div className="restore-action"><Button disabled={Boolean(busy)} onClick={() => importInput.current?.click()}>{t('restore.selectPackage')}</Button></div></article>
                <article className="restore-card"><h3>{t('restore.restoreTitle')}</h3><p>{t('restore.restoreDescription')}</p><div className="restore-flow"><span className="restore-node">{t('restore.selectSnapshot')}</span><span className="restore-arrow"><UiIcon name="arrow-right" size={12}/></span><span className="restore-node">{t('restore.compareCurrent')}</span><span className="restore-arrow"><UiIcon name="arrow-right" size={12}/></span><span className="restore-node">{t('restore.manualConfirm')}</span></div><div className="restore-action"><span className="badge warn">{t('restore.previewOnly')}</span></div></article>
              </div></div>
            </section>
          </div>

          <aside className="future-stack">
            <section className="future-card">
              <div className="future-card-head"><div><h2>{t('create.title')}</h2><p>{t('create.description')}</p></div><span className="badge info">{t('create.local')}</span></div>
              <div className="future-card-body snapshot-builder">
                <div className="builder-block"><div className="builder-label"><span>{t('create.agents')}</span><span>{selectedSources.length} / {detectedSourceCount}</span></div><div className="builder-checks">
                  {sources.filter(source => source.detected).map(source => <label key={source.sourceId} className="builder-check"><input type="checkbox" checked={selectedSources.includes(source.sourceId)} onChange={() => toggleSource(source.sourceId)}/><span className={`src-dot ${sourceDotClass(source.sourceId)}`}/>{sourceLabel(source.sourceId, source.displayName)}<small>{t('create.files', { count: source.fileCount.toLocaleString(locale) })}</small></label>)}
                </div></div>

                {recommendedVisible.length > 0 && <div className="builder-block"><div className="builder-label"><span>{t('create.recommended')}</span><span className="badge ok">{t('create.highValue')}</span></div><div className="builder-checks">{recommendedVisible.map(renderKindCheck)}</div></div>}
                {optionalVisible.length > 0 && <div className="builder-block"><div className="builder-label"><span>{t('create.optional')}</span><span className="badge info">{t('create.large')}</span></div><div className="builder-checks">{optionalVisible.map(renderKindCheck)}</div></div>}
                {otherVisible.length > 0 && <div className="builder-block"><div className="builder-label"><span>{t('create.excluded')}</span><span className="badge">{t('create.unclearValue')}</span></div><div className="builder-checks">{otherVisible.map(renderKindCheck)}</div></div>}

                <div className="safety-note"><span><UiIcon name="check" size={16}/></span><div><b>{t('create.safetyTitle')}</b><span>{t('create.safetyDescription')}</span></div></div>
                <div className="builder-summary"><span>{t('create.estimate', { count: estimatedSelected.toLocaleString(locale) })}</span><span>{hasSelectedBytes ? t('create.estimateSize', { size: formatBytes(estimatedSelectedBytes) }) : t('create.sizePending')} · {t('create.dedupe')}</span></div>
                <Button variant="primary" className="snapshot-create-button" loading={busy === 'create'} disabled={Boolean(busy) || !selectedSources.length || !selectedKinds.length} onClick={requestCreateSnapshot}>{t('create.createAndVerify')}</Button>
              </div>
            </section>

            <section className="future-card"><div className="future-card-head"><div><h3>{t('principles.title')}</h3></div></div><div className="future-card-body backup-principles">
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">{t('principles.understand')}</span><b>{t('principles.logicalPhysical')}</b></div><p>{t('principles.logicalPhysicalDescription')}</p></div>
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">{t('principles.originalFirst')}</span><b>{t('principles.nativeSessions')}</b></div><p>{t('principles.nativeSessionsDescription')}</p></div>
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">{t('principles.noCleanup')}</span><b>{t('principles.noDelete')}</b></div><p>{t('principles.noDeleteDescription')}</p></div>
            </div></section>
          </aside>
        </div>
      </main>
    </div>

    {detailSource && <Drawer
      open
      className="backup-data-drawer"
      title={<span className="backup-overlay-title"><span className={`src-dot lg ${sourceDotClass(detailSource.sourceId)}`}/>{sourceLabel(detailSource.sourceId, detailSource.displayName)}</span>}
      description={t('detail.description')}
      onClose={() => { if (!busy) setDetailSourceId(null) }}
      closeDisabled={Boolean(busy)}
      closeOnBackdrop={!busy}
    >
      <div className="future-drawer-body">
        <section className="drawer-section"><h3>{t('detail.scale')}</h3><div className="preview-summary"><span><b>{detailSource.logicalAssetCount === undefined ? '—' : detailSource.logicalAssetCount.toLocaleString()}</b> {t('detail.logicalAssets')}</span><span><b>{detailSource.fileCount.toLocaleString()}</b> {t('detail.physicalFiles')}</span><span><b>{formatOptionalBytes(detailSource.totalBytes, t)}</b> {t('detail.dataSize')}</span><span><b>{detailSource.excludedCount.toLocaleString()}</b> {t('detail.scanExcluded')}</span></div>{detailSource.logicalAssetCount === undefined && <div className="future-note">{t('detail.logicalUnknown')}</div>}</section>

        <section className="drawer-section"><h3>{t('detail.categories')}</h3><div className="drawer-file-list">
          {ALL_KINDS.filter(kind => kindFiles(detailSource, kind) > 0).map(kind => <div key={kind} className="drawer-file preview-file"><span className={`badge ${recommendationTone(kind)}`}>{kindRecommendation(kind, t)}</span><b>{kindLabel(kind, t)}</b><code>{kindDetailText(detailSource, kind, t, locale)}{kindBytes(detailSource, kind) === undefined ? '' : ` · ${formatBytes(kindBytes(detailSource, kind)!)}`}</code></div>)}
        </div></section>

        <section className="drawer-section"><h3>{t('detail.locations')}</h3>{detailSource.roots?.length
          ? <div>{detailSource.roots.map(root => <BackupDataRootTree key={`${root.scope}:${root.path}`} root={root} onCopy={path => void copyPath(path)}/>)}</div>
          : <div className="future-note">{t('detail.locationsPending')}</div>}</section>

        {(detailSource.oldestModifiedAt || detailSource.latestModifiedAt || detailSource.ageBuckets) && <section className="drawer-section"><h3>{t('detail.timeDistribution')}</h3>{detailSource.oldestModifiedAt || detailSource.latestModifiedAt ? <div className="integrity-strip"><span>{t('detail.oldest', { time: detailSource.oldestModifiedAt ? formatTime(detailSource.oldestModifiedAt, locale) : '—' })}</span><span className="grow"/><span>{t('detail.latest', { time: detailSource.latestModifiedAt ? formatTime(detailSource.latestModifiedAt, locale) : '—' })}</span></div> : null}{detailSource.ageBuckets && <div className="preview-summary"><span><b>{detailSource.ageBuckets.recent30Days.fileCount.toLocaleString()}</b> {t('detail.recent30')}</span><span><b>{detailSource.ageBuckets.days31To90.fileCount.toLocaleString()}</b> {t('detail.days31To90')}</span><span><b>{detailSource.ageBuckets.days91To180.fileCount.toLocaleString()}</b> {t('detail.days91To180')}</span><span><b>{detailSource.ageBuckets.olderThan180Days.fileCount.toLocaleString()}</b> {t('detail.older180')}</span></div>}</section>}

        <section className="drawer-section"><div className="future-note"><b>{t('detail.purposeTitle')}</b> {t('detail.purposeDescription', { agent: sourceLabel(detailSource.sourceId, detailSource.displayName) })}</div></section>
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
      description={t('confirm.description')}
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
