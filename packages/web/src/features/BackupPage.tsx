import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type {
  BackupAssetKindDto,
  BackupOverviewResponseDto,
  BackupProtectionSourceDto,
  BackupRestorePreviewResponseDto,
  BackupVerifyResponseDto,
} from '@agent-lens/protocol'
import { AgentLensApi } from '../client/api'
import { agentLabel } from '../components/AgentScope'
import { BackupDataRootTree } from '../components/BackupDirectoryTree'
import { CompactPageHeading } from '../components/CompactPageHeading'
import { PageLoadingState } from '../components/StateViews'
import { Button, Dialog, Drawer, Toolbar } from '../components/ui'
import { UiIcon } from '../components/UiIcon'

const RECOMMENDED_KINDS: BackupAssetKindDto[] = ['config', 'skill', 'mcp', 'plugin', 'extension', 'hook', 'rule']
const OPTIONAL_KINDS: BackupAssetKindDto[] = ['session', 'memory']
const OTHER_KINDS: BackupAssetKindDto[] = ['other']
const ALL_KINDS: BackupAssetKindDto[] = [...RECOMMENDED_KINDS, ...OPTIONAL_KINDS, ...OTHER_KINDS]

type PendingConfirmation =
  | { type: 'create' }
  | { type: 'import'; file: File }

function kindLabel(kind: BackupAssetKindDto): string {
  if (kind === 'skill') return '技能'
  if (kind === 'mcp') return 'MCP（模型上下文协议）'
  if (kind === 'plugin') return '插件'
  if (kind === 'extension') return '扩展'
  if (kind === 'hook') return '钩子'
  if (kind === 'memory') return '记忆'
  if (kind === 'rule') return '规则'
  if (kind === 'session') return '会话 / 历史'
  if (kind === 'config') return '关键配置'
  return '其他 / 未分类'
}

function kindRecommendation(kind: BackupAssetKindDto): '建议备份' | '按需备份' | '默认排除' {
  if (RECOMMENDED_KINDS.includes(kind)) return '建议备份'
  if (OPTIONAL_KINDS.includes(kind)) return '按需备份'
  return '默认排除'
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

function formatOptionalBytes(bytes: number | undefined): string {
  return bytes === undefined ? '大小待扫描' : formatBytes(bytes)
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
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

function previewStatusLabel(status: string): string {
  if (status === 'unchanged') return '一致'
  if (status === 'missing') return '当前缺失'
  if (status === 'modified') return '当前已修改'
  return '阻止恢复'
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

function kindDetailText(source: BackupProtectionSourceDto, kind: BackupAssetKindDto): string {
  const files = kindFiles(source, kind)
  const logical = kindLogicalAssets(source, kind)
  return logical === undefined ? `${files.toLocaleString()} 个文件` : `${logical.toLocaleString()} 项 · ${files.toLocaleString()} 个文件`
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

export function BackupPage() {
  const api = useMemo(() => new AgentLensApi(), [])
  const [overview, setOverview] = useState<BackupOverviewResponseDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [selectedSources, setSelectedSources] = useState<string[]>([])
  const [selectedKinds, setSelectedKinds] = useState<BackupAssetKindDto[]>(RECOMMENDED_KINDS)
  const [verification, setVerification] = useState<Record<string, BackupVerifyResponseDto>>({})
  const [preview, setPreview] = useState<BackupRestorePreviewResponseDto | null>(null)
  const [detailSourceId, setDetailSourceId] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const selectionInitialized = useRef(false)
  const importInput = useRef<HTMLInputElement>(null)

  const applyOverview = (next: BackupOverviewResponseDto) => {
    setOverview(next)
    // 渐进扫描期间只展示已完成 Source，不提前把默认备份范围锁成第一个智能体。
    if (!selectionInitialized.current && next.index?.ready !== false && next.index?.refreshing !== true) {
      selectionInitialized.current = true
      setSelectedSources(next.sources.filter(source => source.detected).map(source => source.sourceId))
    }
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

  const sources = overview?.sources ?? []
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
    setSelectedSources(current => current.includes(sourceId)
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
      setSuccess(`快照已创建：${result.snapshot.files.length.toLocaleString()} 个文件 · ${formatBytes(bytes)}${excluded ? ` · ${excluded.toLocaleString()} 项按安全规则排除` : ''}`)
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
      setError('复制路径失败，请手动选择路径文本。')
    }
  }

  if (!overview || overview.index?.ready === false) return <PageLoadingState
    eyebrow="资产备份"
    statusLabel="首次建立索引"
    title="正在准备资产备份范围"
    description="后台正在按已配置智能体顺序建立首份本地备份索引。首个智能体完成后会立即展示，后续结果继续渐进补齐。"
    facts={['按智能体顺序加载', '不会修改原始文件', '完成一个立即展示一个']}
  />

  const indexTime = overview.index?.generatedAt
  const indexRefreshing = overview.index?.refreshing ?? false
  const refreshing = loading || indexRefreshing
  const detectedSourceCount = sources.filter(source => source.detected).length
  const allDetectedSelected = detectedSourceCount > 0 && selectedSources.length === detectedSourceCount
  const recommendedVisible = policyKinds(RECOMMENDED_KINDS, sources, selectedSources)
  const optionalVisible = policyKinds(OPTIONAL_KINDS, sources, selectedSources)
  const otherVisible = policyKinds(OTHER_KINDS, sources, selectedSources)

  const renderKindCheck = (kind: BackupAssetKindDto) => {
    const files = sumKindFiles(sources, selectedSources, kind)
    const logical = sumKindLogicalAssets(sources, selectedSources, kind)
    return <label key={kind} className="builder-check">
      <input type="checkbox" checked={selectedKinds.includes(kind)} onChange={() => toggleKind(kind)}/>
      {kindLabel(kind)}
      <small>{logical === undefined ? `${files.toLocaleString()} 文件` : `${logical.toLocaleString()} 项 · ${files.toLocaleString()} 文件`}</small>
    </label>
  }

  return <>
    <Toolbar className="workspace-toolbar" aria-label="资产备份工具栏">
      <div className="agent-scope">
        <button className={`scope-chip ${allDetectedSelected ? 'scope-chip-active' : ''}`} onClick={() => setSelectedSources(sources.filter(source => source.detected).map(source => source.sourceId))}>全部智能体</button>
        {sources.map(source => <button key={source.sourceId} disabled={!source.detected} className={`scope-chip ${selectedSources.includes(source.sourceId) ? 'scope-chip-active' : ''}`} onClick={() => toggleSource(source.sourceId)}>
          <span className={`src-dot ${sourceDotClass(source.sourceId)}`}/>{sourceLabel(source.sourceId, source.displayName)}
        </button>)}
      </div>
      <span className="toolbar-divider"/>
      <span className="backup-toolbar-note">默认排除凭据、令牌与私钥</span>
      <Button className="toolbar-end" loading={busy === 'import'} disabled={Boolean(busy)} onClick={() => importInput.current?.click()}><UiIcon name="upload" size={14}/>导入备份包</Button>
      <Button variant="primary" loading={busy === 'create'} disabled={Boolean(busy) || !selectedSources.length || !selectedKinds.length} onClick={requestCreateSnapshot}><UiIcon name="plus" size={14}/>创建快照</Button>
      <input ref={importInput} className="backup-file-input" type="file" accept=".agentlens-backup,application/vnd.agentlens.backup" onChange={selectImportBackup}/>
    </Toolbar>

    <div className="page-scroll">
      <main className="future-content backup-page">
        <div className="future-heading">
          <CompactPageHeading title="资产备份" description="看清智能体真正有哪些数据、在哪里、占多少，再决定哪些值得进入本地不可变快照。恢复仍必须先经过差异预演。"><span className="prototype-flag live">本地真实数据</span></CompactPageHeading>
          <Button loading={refreshing} disabled={refreshing || Boolean(busy)} onClick={() => void refresh(true)}><UiIcon name="refresh" size={14}/>刷新扫描</Button>
        </div>

        {error && <div className="backup-error" role="alert"><b>操作失败</b><span>{error}</span><button className="link-btn" onClick={() => setError('')}>关闭</button></div>}
        {success && <div className="future-note" role="status"><b>操作完成</b> · {success}</div>}

        <section className="future-kpis" aria-label="备份概览">
          <article className="future-kpi"><div className="future-kpi-head"><span>可备份物理文件</span><span className={`badge ${indexRefreshing ? 'info' : 'ok'}`}>{indexRefreshing ? '后台更新中' : '索引就绪'}</span></div><strong>{protectedFiles.toLocaleString()}</strong><small>{hasProtectedBytes ? `${formatBytes(protectedBytes)} · ` : ''}{indexTime ? `索引更新于 ${formatTime(indexTime)} · ` : ''}{detectedSourceCount} 个智能体</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>本地快照</span><span className="delta neutral">{snapshots[0] ? `最近 ${formatTime(snapshots[0].createdAt)}` : '尚无快照'}</span></div><strong>{snapshots.length}</strong><small>逻辑内容共 {formatBytes(totalSnapshotBytes)}；相同文件由内容库复用</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>最近校验</span><span className={`badge ${Object.values(verification).some(result => !result.valid) ? 'err' : Object.keys(verification).length ? 'ok' : ''}`}>{Object.keys(verification).length ? (Object.values(verification).every(result => result.valid) ? '通过' : '需关注') : '未执行'}</span></div><strong>{Object.values(verification).filter(result => result.valid).length}/{Object.keys(verification).length || '—'}</strong><small>校验清单和每个快照文件的 SHA-256</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>扫描阶段排除</span><span className="badge warn">安全优先</span></div><strong>{excludedFiles.toLocaleString()}</strong><small>符号链接、越界路径等在扫描阶段排除；秘密内容在创建快照时继续检查</small></article>
        </section>

        <div className="future-grid">
          <div className="future-stack">
            <section className="future-card">
              <div className="future-card-head"><div><h2>保护范围</h2><p>逻辑资产和物理文件分开显示。旧索引只知道文件数量时，会明确写成“文件”，不会把 4,000 个文件误称为 4,000 个 MCP。</p></div></div>
              <div className="future-card-body">
                <div className="protection-grid">
                  {sources.map(source => <article key={source.sourceId} className={`protection-card ${!source.detected ? 'is-muted' : ''}`}>
                    <div className="protection-card-head"><span className={`src-dot lg ${sourceDotClass(source.sourceId)}`}/><b>{sourceLabel(source.sourceId, source.displayName)}</b><span className={`badge ${source.detected ? 'ok' : ''}`}>{source.detected ? '已检测' : '未检测'}</span></div>
                    <div className="protection-counts">
                      <div className="protection-count"><strong>{source.logicalAssetCount === undefined ? '—' : source.logicalAssetCount.toLocaleString()}</strong><span>逻辑资产</span></div>
                      <div className="protection-count"><strong>{source.fileCount.toLocaleString()}</strong><span>物理文件</span></div>
                      <div className="protection-count"><strong>{source.totalBytes === undefined ? '—' : formatBytes(source.totalBytes)}</strong><span>数据大小</span></div>
                    </div>
                    <div className="protection-meta"><span>MCP {kindDetailText(source, 'mcp')} · 会话 {kindFiles(source, 'session').toLocaleString()} 文件</span><button className="link-btn" disabled={!source.detected} onClick={() => setDetailSourceId(source.sourceId)}>数据详情</button></div>
                  </article>)}
                </div>
                <div className="future-section-label">当前备份目录</div>
                <div className="integrity-strip"><strong>本地备份仓</strong><code>{overview?.vaultPath ?? '—'}</code><span className="grow"/><span>{indexTime ? `索引 ${formatTime(indexTime)}` : '索引准备中'} · 不写入规范事实表</span></div>
              </div>
            </section>

            <section className="future-card">
              <div className="future-card-head"><div><h2>最近快照</h2><p>快照创建后清单不可变；相同内容只在本地内容库保存一份。</p></div><Button size="small" loading={busy === 'verify-all'} disabled={Boolean(busy) || !snapshots.length} onClick={() => void verifyAll()}>验证全部</Button></div>
              {snapshots.length ? <div className="future-table-scroll"><table className="snapshot-table"><thead><tr><th>快照</th><th>来源</th><th>大小</th><th>完整性</th><th>排除</th><th>哈希</th><th className="align-right">操作</th></tr></thead><tbody>
                {snapshots.map(snapshot => {
                  const checked = verification[snapshot.id]
                  return <tr key={snapshot.id}>
                    <td><div className="snapshot-name"><span className="snapshot-icon">{checked ? (checked.valid ? <UiIcon name="check" size={14}/> : <UiIcon name="alert" size={14}/>) : <UiIcon name="dot" size={14}/>}</span><span><b>{formatTime(snapshot.createdAt)}</b><small>{snapshot.fileCount} 个文件</small></span></div></td>
                    <td>{snapshot.sourceIds.map(sourceId => sourceLabel(sourceId)).join(' · ') || '—'}</td>
                    <td>{formatBytes(snapshot.totalBytes)}</td>
                    <td>{checked ? <span className={`badge ${checked.valid ? 'ok' : 'err'}`}>{checked.valid ? '校验通过' : '校验失败'}</span> : <span className="badge">未校验</span>}</td>
                    <td>{snapshot.excludedCount}</td>
                    <td><span className="hash">{shortHash(snapshot.manifestSha256)}</span></td>
                    <td><div className="table-actions"><button className="link-btn" disabled={Boolean(busy)} onClick={() => void verifySnapshot(snapshot.id)}>校验</button><button className="link-btn" disabled={Boolean(busy)} onClick={() => void showRestorePreview(snapshot.id)}>恢复预演</button><button className="link-btn" disabled={Boolean(busy)} onClick={() => void exportSnapshot(snapshot.id)}>导出</button></div></td>
                  </tr>
                })}
              </tbody></table></div> : <div className="backup-empty"><b>还没有本地快照</b><span>右侧选择需要保护的智能体与资产类型，然后创建第一个快照。</span></div>}
            </section>

            <section className="future-card">
              <div className="future-card-head"><div><h2>导入与恢复</h2><p>导入只进入本地备份仓；正式写回前必须先计算当前机器上的差异。</p></div><span className="badge info">恢复预演优先</span></div>
              <div className="future-card-body"><div className="restore-grid">
                <article className="restore-card"><h3>导入备份包</h3><p>先验证清单与文件哈希；同名快照只有内容完全一致才允许复用。选择后还会再次确认。</p><div className="restore-flow"><span className="restore-node">选择文件</span><span className="restore-arrow"><UiIcon name="arrow-right" size={13}/></span><span className="restore-node">二次确认</span><span className="restore-arrow"><UiIcon name="arrow-right" size={13}/></span><span className="restore-node">完整性校验</span></div><div className="restore-action"><Button disabled={Boolean(busy)} onClick={() => importInput.current?.click()}>选择备份包</Button></div></article>
                <article className="restore-card"><h3>恢复到原智能体</h3><p>目标路径由当前机器重新检测的配置/数据根目录和快照相对路径计算，不信任导入包里的绝对路径。</p><div className="restore-flow"><span className="restore-node">选择快照</span><span className="restore-arrow"><UiIcon name="arrow-right" size={13}/></span><span className="restore-node">对比当前</span><span className="restore-arrow"><UiIcon name="arrow-right" size={13}/></span><span className="restore-node">人工确认</span></div><div className="restore-action"><span className="badge warn">当前版本只开放预演，不直接写回</span></div></article>
              </div></div>
            </section>
          </div>

          <aside className="future-stack">
            <section className="future-card">
              <div className="future-card-head"><div><h2>创建快照</h2><p>按数据价值选择，不需要面对十几万文件逐个勾选。</p></div><span className="badge info">本地</span></div>
              <div className="future-card-body snapshot-builder">
                <div className="builder-block"><div className="builder-label"><span>智能体</span><span>{selectedSources.length} / {detectedSourceCount}</span></div><div className="builder-checks">
                  {sources.filter(source => source.detected).map(source => <label key={source.sourceId} className="builder-check"><input type="checkbox" checked={selectedSources.includes(source.sourceId)} onChange={() => toggleSource(source.sourceId)}/><span className={`src-dot ${sourceDotClass(source.sourceId)}`}/>{sourceLabel(source.sourceId, source.displayName)}<small>{source.fileCount.toLocaleString()} 文件</small></label>)}
                </div></div>

                {recommendedVisible.length > 0 && <div className="builder-block"><div className="builder-label"><span>建议备份</span><span className="badge ok">恢复价值高</span></div><div className="builder-checks">{recommendedVisible.map(renderKindCheck)}</div></div>}
                {optionalVisible.length > 0 && <div className="builder-block"><div className="builder-label"><span>按需备份</span><span className="badge info">可能占用较大</span></div><div className="builder-checks">{optionalVisible.map(renderKindCheck)}</div></div>}
                {otherVisible.length > 0 && <div className="builder-block"><div className="builder-label"><span>默认排除</span><span className="badge">价值不明确</span></div><div className="builder-checks">{otherVisible.map(renderKindCheck)}</div></div>}

                <div className="safety-note"><span><UiIcon name="check" size={15}/></span><div><b>敏感信息保护强制开启</b><span>没有关闭入口。发现凭据文件名、私钥、常见令牌或配置中的秘密赋值时，整文件排除并只记录原因。</span></div></div>
                <div className="builder-summary"><span>预计涉及约 <b>{estimatedSelected.toLocaleString()}</b> 条分类文件引用</span><span>{hasSelectedBytes ? `分类大小约 ${formatBytes(estimatedSelectedBytes)}` : '大小将在新版扫描索引补齐后显示'} · 重叠路径创建时自动去重</span></div>
                <Button variant="primary" className="snapshot-create-button" loading={busy === 'create'} disabled={Boolean(busy) || !selectedSources.length || !selectedKinds.length} onClick={requestCreateSnapshot}>创建并校验快照</Button>
              </div>
            </section>

            <section className="future-card"><div className="future-card-head"><div><h3>备份原则</h3></div></div><div className="future-card-body backup-principles">
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">先看懂</span><b>逻辑资产和物理文件分开</b></div><p>文件很多不等于装了很多 MCP 或技能；不确定时只展示可验证的物理文件数量。</p></div>
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">原始优先</span><b>会话保存原生文件</b></div><p>规范观测用于查看和分析，不替代原工具的会话 / 历史文件。</p></div>
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">不清理</span><b>AgentLens 不删除原始数据</b></div><p>这里只决定哪些数据进入快照，不承担第三方智能体的数据清理职责。</p></div>
            </div></section>
          </aside>
        </div>
      </main>
    </div>

    {detailSource && <Drawer
      open
      className="backup-data-drawer"
      title={<span className="backup-overlay-title"><span className={`src-dot lg ${sourceDotClass(detailSource.sourceId)}`}/>{sourceLabel(detailSource.sourceId, detailSource.displayName)}</span>}
      description="帮助判断这些数据是什么、在哪里，以及是否值得进入快照。"
      onClose={() => { if (!busy) setDetailSourceId(null) }}
      closeDisabled={Boolean(busy)}
      closeOnBackdrop={!busy}
    >
      <div className="future-drawer-body">
        <section className="drawer-section"><h3>数据规模</h3><div className="preview-summary"><span><b>{detailSource.logicalAssetCount === undefined ? '—' : detailSource.logicalAssetCount.toLocaleString()}</b> 逻辑资产</span><span><b>{detailSource.fileCount.toLocaleString()}</b> 物理文件</span><span><b>{formatOptionalBytes(detailSource.totalBytes)}</b> 数据大小</span><span><b>{detailSource.excludedCount.toLocaleString()}</b> 扫描排除</span></div>{detailSource.logicalAssetCount === undefined && <div className="future-note">当前索引还不能可靠计算全部逻辑资产数量，因此不会把文件数冒充为 MCP、技能或会话数量。</div>}</section>

        <section className="drawer-section"><h3>资产分类</h3><div className="drawer-file-list">
          {ALL_KINDS.filter(kind => kindFiles(detailSource, kind) > 0).map(kind => <div key={kind} className="drawer-file preview-file"><span className={`badge ${recommendationTone(kind)}`}>{kindRecommendation(kind)}</span><b>{kindLabel(kind)}</b><code>{kindDetailText(detailSource, kind)}{kindBytes(detailSource, kind) === undefined ? '' : ` · ${formatBytes(kindBytes(detailSource, kind)!)}`}</code></div>)}
        </div></section>

        <section className="drawer-section"><h3>数据位置</h3>{detailSource.roots?.length
          ? <div>{detailSource.roots.map(root => <BackupDataRootTree key={`${root.scope}:${root.path}`} root={root} onCopy={path => void copyPath(path)}/>)}</div>
          : <div className="future-note">当前索引版本只提供分类文件统计；刷新到包含目录统计的新版索引后，这里会显示真实配置目录和数据目录。</div>}</section>

        {(detailSource.oldestModifiedAt || detailSource.latestModifiedAt || detailSource.ageBuckets) && <section className="drawer-section"><h3>时间分布</h3>{detailSource.oldestModifiedAt || detailSource.latestModifiedAt ? <div className="integrity-strip"><span>最早 {detailSource.oldestModifiedAt ? formatTime(detailSource.oldestModifiedAt) : '—'}</span><span className="grow"/><span>最近 {detailSource.latestModifiedAt ? formatTime(detailSource.latestModifiedAt) : '—'}</span></div> : null}{detailSource.ageBuckets && <div className="preview-summary"><span><b>{detailSource.ageBuckets.recent30Days.fileCount.toLocaleString()}</b> 最近 30 天</span><span><b>{detailSource.ageBuckets.days31To90.fileCount.toLocaleString()}</b> 31–90 天</span><span><b>{detailSource.ageBuckets.days91To180.fileCount.toLocaleString()}</b> 91–180 天</span><span><b>{detailSource.ageBuckets.olderThan180Days.fileCount.toLocaleString()}</b> 180 天以前</span></div>}</section>}

        <section className="drawer-section"><div className="future-note"><b>这里只帮助你决定备什么。</b> AgentLens 1.0 不删除、不移动、不清理 {sourceLabel(detailSource.sourceId, detailSource.displayName)} 的原始数据。</div></section>
      </div>
    </Drawer>}

    {preview && <Drawer
      open
      className="backup-preview-drawer"
      title={<span className="backup-overlay-title">快照差异 <span className={`badge ${preview.blocked ? 'warn' : 'ok'}`}>{preview.blocked ? `${preview.blocked} 项阻止` : '路径检查通过'}</span></span>}
      description={preview.snapshotId}
      onClose={() => { if (!busy) setPreview(null) }}
      closeDisabled={Boolean(busy)}
      closeOnBackdrop={!busy}
    >
      <div className="future-drawer-body">
        <section className="drawer-section"><h3>差异摘要</h3><div className="preview-summary"><span><b>{preview.unchanged}</b> 一致</span><span><b>{preview.missing}</b> 缺失</span><span><b>{preview.modified}</b> 已修改</span><span><b>{preview.blocked}</b> 阻止</span></div></section>
        <section className="drawer-section"><h3>文件</h3><div className="drawer-file-list">{preview.items.map(item => <div key={`${item.sourceId}:${item.archivePath}`} className="drawer-file preview-file"><span className={`badge ${item.status === 'blocked' ? 'err' : item.status === 'modified' ? 'warn' : item.status === 'unchanged' ? 'ok' : 'info'}`}>{previewStatusLabel(item.status)}</span><code>{item.targetPath ?? item.archivePath}</code>{item.reason && <small>{item.reason}</small>}</div>)}</div></section>
        <section className="drawer-section"><div className="future-note"><b>这里只做预演。</b> 当前版本没有直接写回接口，因此查看差异不会修改任何已检测智能体的文件。</div></section>
      </div>
    </Drawer>}

    {confirmation && <Dialog
      open
      className="backup-confirm-overlay"
      title={confirmation.type === 'create' ? '确认创建本地快照？' : '确认导入这个备份包？'}
      description="关键操作确认"
      onClose={() => { if (!busy) setConfirmation(null) }}
      closeDisabled={Boolean(busy)}
      closeOnBackdrop={!busy}
      footer={<>
        <Button disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>取消</Button>
        <Button variant="primary" disabled={Boolean(busy)} onClick={() => void confirmCriticalOperation()}>{confirmation.type === 'create' ? '确认创建' : '确认导入'}</Button>
      </>}
    >
      <div className="backup-confirm-content">
        <div className="backup-confirm-icon"><UiIcon name="alert" size={20}/></div>
        <div className="backup-confirm-copy">
          {confirmation.type === 'create'
            ? <p>将把当前选中的 {selectedSources.length} 个智能体、{selectedKinds.length} 类资产写入本地备份仓。敏感信息保护保持强制开启；已有相同内容会直接复用。</p>
            : <p>文件 <b>{confirmation.file.name}</b>（{formatBytes(confirmation.file.size)}）将经过完整性校验后写入本地备份仓，不会覆盖当前智能体文件。</p>}
          <div className="backup-confirm-facts">
            {confirmation.type === 'create'
              ? <><span>约 {estimatedSelected.toLocaleString()} 条分类文件引用</span><span>{hasSelectedBytes ? `分类大小约 ${formatBytes(estimatedSelectedBytes)}` : `索引 ${indexTime ? formatTime(indexTime) : '准备中'}`}</span></>
              : <><span>只导入到本地备份仓</span><span>恢复仍需单独预演</span></>}
          </div>
        </div>
      </div>
    </Dialog>}
  </>
}
