import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type {
  BackupAssetKindDto,
  BackupOverviewResponseDto,
  BackupRestorePreviewResponseDto,
  BackupVerifyResponseDto,
} from '@agent-lens/protocol'
import { AgentLensApi } from '../client/api'
import { agentLabel } from '../components/AgentScope'
import { CompactPageHeading } from '../components/CompactPageHeading'
import { WorkspaceSkeleton } from '../components/StateViews'
import { UiIcon } from '../components/UiIcon'

const ALL_KINDS: BackupAssetKindDto[] = [
  'skill', 'mcp', 'plugin', 'extension', 'hook', 'memory', 'rule', 'session', 'config', 'other',
]

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
  return '其他'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
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

export function BackupPage() {
  const api = useMemo(() => new AgentLensApi(), [])
  const [overview, setOverview] = useState<BackupOverviewResponseDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [selectedSources, setSelectedSources] = useState<string[]>([])
  const [selectedKinds, setSelectedKinds] = useState<BackupAssetKindDto[]>(ALL_KINDS)
  const [verification, setVerification] = useState<Record<string, BackupVerifyResponseDto>>({})
  const [preview, setPreview] = useState<BackupRestorePreviewResponseDto | null>(null)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const selectionInitialized = useRef(false)
  const importInput = useRef<HTMLInputElement>(null)

  const refresh = async (force = false) => {
    setLoading(true)
    setError('')
    try {
      const next = force ? await api.refreshBackupOverview() : await api.backupOverview()
      setOverview(next)
      if (!selectionInitialized.current) {
        selectionInitialized.current = true
        setSelectedSources(next.sources.filter(source => source.detected).map(source => source.sourceId))
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (!preview && !confirmation) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      if (confirmation) setConfirmation(null)
      else setPreview(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [preview, confirmation, busy])

  const sources = overview?.sources ?? []
  const snapshots = overview?.snapshots ?? []
  const protectedFiles = sources.reduce((sum, source) => sum + source.fileCount, 0)
  const excludedFiles = sources.reduce((sum, source) => sum + source.excludedCount, 0)
  const totalSnapshotBytes = snapshots.reduce((sum, snapshot) => sum + snapshot.totalBytes, 0)
  const estimatedSelected = sources
    .filter(source => selectedSources.includes(source.sourceId))
    .reduce((sum, source) => sum + selectedKinds.reduce((kindSum, kind) => kindSum + (source.kinds[kind] ?? 0), 0), 0)

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
    setConfirmation({ type: 'create' })
  }

  const createSnapshot = async () => {
    if (!selectedSources.length || !selectedKinds.length || busy) return
    setBusy('create')
    setError('')
    try {
      await api.createBackup({ sourceIds: selectedSources, kinds: selectedKinds })
      await refresh()
    } catch (reason) {
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

  if (loading && !overview) return <WorkspaceSkeleton />

  const indexTime = overview?.index?.generatedAt
  const indexRefreshing = overview?.index?.refreshing ?? false
  const detectedSourceCount = sources.filter(source => source.detected).length
  const allDetectedSelected = detectedSourceCount > 0 && selectedSources.length === detectedSourceCount

  return <>
    <div className="workspace-toolbar">
      <div className="agent-scope">
        <button className={`scope-chip ${allDetectedSelected ? 'scope-chip-active' : ''}`} onClick={() => setSelectedSources(sources.filter(source => source.detected).map(source => source.sourceId))}>全部智能体</button>
        {sources.map(source => <button key={source.sourceId} disabled={!source.detected} className={`scope-chip ${selectedSources.includes(source.sourceId) ? 'scope-chip-active' : ''}`} onClick={() => toggleSource(source.sourceId)}>
          <span className={`src-dot ${sourceDotClass(source.sourceId)}`}/>{sourceLabel(source.sourceId, source.displayName)}
        </button>)}
      </div>
      <span className="toolbar-divider"/>
      <span className="backup-toolbar-note">默认排除凭据、令牌与私钥</span>
      <button className="btn toolbar-end" disabled={Boolean(busy)} onClick={() => importInput.current?.click()}>{busy === 'import' ? '正在导入…' : <><UiIcon name="upload" size={14}/>{' 导入备份包'}</>}</button>
      <button className="btn primary" disabled={Boolean(busy) || !selectedSources.length || !selectedKinds.length} onClick={requestCreateSnapshot}>{busy === 'create' ? '正在创建…' : <><UiIcon name="plus" size={14}/>{' 创建快照'}</>}</button>
      <input ref={importInput} className="backup-file-input" type="file" accept=".agentlens-backup,application/vnd.agentlens.backup" onChange={selectImportBackup}/>
    </div>

    <div className="page-scroll">
      <main className="future-content backup-page">
        <div className="future-heading">
          <CompactPageHeading title="资产备份" description="将智能体原始会话和已发现资产保存为本地不可变快照。清单与 SHA-256 用于完整性校验；导入不会直接覆盖当前文件，恢复必须先经过差异预演。"><span className="prototype-flag live">本地真实数据</span></CompactPageHeading>
          <button className="btn" disabled={loading || Boolean(busy)} onClick={() => void refresh(true)}>{loading ? '正在扫描…' : <><UiIcon name="refresh" size={14}/>{' 刷新扫描'}</>}</button>
        </div>

        {error && <div className="backup-error" role="alert"><b>操作失败</b><span>{error}</span><button className="link-btn" onClick={() => setError('')}>关闭</button></div>}

        <section className="future-kpis" aria-label="备份概览">
          <article className="future-kpi"><div className="future-kpi-head"><span>可备份源文件</span><span className={`badge ${indexRefreshing ? 'info' : 'ok'}`}>{indexRefreshing ? '后台更新中' : '索引就绪'}</span></div><strong>{protectedFiles}</strong><small>{indexTime ? `索引更新于 ${formatTime(indexTime)} · ` : ''}{detectedSourceCount} 个智能体</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>本地快照</span><span className="delta neutral">{snapshots[0] ? `最近 ${formatTime(snapshots[0].createdAt)}` : '尚无快照'}</span></div><strong>{snapshots.length}</strong><small>逻辑内容共 {formatBytes(totalSnapshotBytes)}；相同文件由内容库复用</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>最近校验</span><span className={`badge ${Object.values(verification).some(result => !result.valid) ? 'err' : Object.keys(verification).length ? 'ok' : ''}`}>{Object.keys(verification).length ? (Object.values(verification).every(result => result.valid) ? '通过' : '需关注') : '未执行'}</span></div><strong>{Object.values(verification).filter(result => result.valid).length}/{Object.keys(verification).length || '—'}</strong><small>校验清单和每个快照文件的 SHA-256</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>扫描阶段排除</span><span className="badge warn">安全优先</span></div><strong>{excludedFiles}</strong><small>符号链接、越界路径等在扫描阶段排除；秘密内容在创建快照时继续检查</small></article>
        </section>

        <div className="future-grid">
          <div className="future-stack">
            <section className="future-card">
              <div className="future-card-head"><div><h2>保护范围</h2><p>这里展示来源当前真实暴露的原始会话根目录和资产绑定路径，不根据“应该安装什么”猜测。</p></div></div>
              <div className="future-card-body">
                <div className="protection-grid">
                  {sources.map(source => <article key={source.sourceId} className={`protection-card ${!source.detected ? 'is-muted' : ''}`}>
                    <div className="protection-card-head"><span className={`src-dot lg ${sourceDotClass(source.sourceId)}`}/><b>{sourceLabel(source.sourceId, source.displayName)}</b><span className={`badge ${source.detected ? 'ok' : ''}`}>{source.detected ? '已检测' : '未检测'}</span></div>
                    <div className="protection-counts">
                      <div className="protection-count"><strong>{source.kinds.skill ?? 0}</strong><span>技能文件</span></div>
                      <div className="protection-count"><strong>{source.kinds.session ?? 0}</strong><span>会话文件</span></div>
                      <div className="protection-count"><strong>{source.fileCount}</strong><span>全部文件</span></div>
                    </div>
                    <div className="protection-meta"><span>MCP {source.kinds.mcp ?? 0} · 插件/扩展 {(source.kinds.plugin ?? 0) + (source.kinds.extension ?? 0)}</span><span>{source.excludedCount ? `排除 ${source.excludedCount}` : '路径正常'}</span></div>
                  </article>)}
                </div>
                <div className="future-section-label">当前备份目录</div>
                <div className="integrity-strip"><strong>本地备份仓</strong><code>{overview?.vaultPath ?? '—'}</code><span className="grow"/><span>{indexTime ? `索引 ${formatTime(indexTime)}` : '索引准备中'} · 不写入规范事实表</span></div>
              </div>
            </section>

            <section className="future-card">
              <div className="future-card-head"><div><h2>最近快照</h2><p>快照创建后清单不可变；相同内容只在本地内容库保存一份。</p></div><button className="btn small" disabled={Boolean(busy) || !snapshots.length} onClick={() => void verifyAll()}>{busy === 'verify-all' ? '校验中…' : '验证全部'}</button></div>
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
                <article className="restore-card"><h3>导入备份包</h3><p>先验证清单与文件哈希；同名快照只有内容完全一致才允许复用。选择后还会再次确认。</p><div className="restore-flow"><span className="restore-node">选择文件</span><span className="restore-arrow"><UiIcon name="arrow-right" size={13}/></span><span className="restore-node">二次确认</span><span className="restore-arrow"><UiIcon name="arrow-right" size={13}/></span><span className="restore-node">完整性校验</span></div><div className="restore-action"><button className="btn" disabled={Boolean(busy)} onClick={() => importInput.current?.click()}>选择备份包</button></div></article>
                <article className="restore-card"><h3>恢复到原智能体</h3><p>目标路径由当前机器重新检测的配置/数据根目录和快照相对路径计算，不信任导入包里的绝对路径。</p><div className="restore-flow"><span className="restore-node">选择快照</span><span className="restore-arrow"><UiIcon name="arrow-right" size={13}/></span><span className="restore-node">对比当前</span><span className="restore-arrow"><UiIcon name="arrow-right" size={13}/></span><span className="restore-node">人工确认</span></div><div className="restore-action"><span className="badge warn">当前版本只开放预演，不直接写回</span></div></article>
              </div></div>
            </section>
          </div>

          <aside className="future-stack">
            <section className="future-card">
              <div className="future-card-head"><div><h2>创建快照</h2><p>选择本次真正要保护的范围。</p></div><span className="badge info">本地</span></div>
              <div className="future-card-body snapshot-builder">
                <div className="builder-block"><div className="builder-label"><span>智能体</span><span>{selectedSources.length} / {detectedSourceCount}</span></div><div className="builder-checks">
                  {sources.filter(source => source.detected).map(source => <label key={source.sourceId} className="builder-check"><input type="checkbox" checked={selectedSources.includes(source.sourceId)} onChange={() => toggleSource(source.sourceId)}/><span className={`src-dot ${sourceDotClass(source.sourceId)}`}/>{sourceLabel(source.sourceId, source.displayName)}<small>{source.fileCount} 文件</small></label>)}
                </div></div>
                <div className="builder-block"><div className="builder-label"><span>资产类型</span><button className="link-btn" onClick={() => setSelectedKinds(selectedKinds.length === ALL_KINDS.length ? [] : ALL_KINDS)}>{selectedKinds.length === ALL_KINDS.length ? '清空' : '全选'}</button></div><div className="builder-checks">
                  {ALL_KINDS.map(kind => <label key={kind} className="builder-check"><input type="checkbox" checked={selectedKinds.includes(kind)} onChange={() => toggleKind(kind)}/>{kindLabel(kind)}<small>{sources.filter(source => selectedSources.includes(source.sourceId)).reduce((sum, source) => sum + (source.kinds[kind] ?? 0), 0)}</small></label>)}
                </div></div>
                <div className="safety-note"><span><UiIcon name="check" size={15}/></span><div><b>敏感信息保护强制开启</b><span>没有关闭入口。发现凭据文件名、私钥、常见令牌或配置中的秘密赋值时，整文件排除并只记录原因。</span></div></div>
                <div className="builder-summary"><span>按分类统计约 <b>{estimatedSelected}</b> 条文件引用</span><span>重叠路径会自动去重</span></div>
                <button className="btn primary snapshot-create-button" disabled={Boolean(busy) || !selectedSources.length || !selectedKinds.length} onClick={requestCreateSnapshot}>{busy === 'create' ? '正在创建快照…' : '创建并校验快照'}</button>
              </div>
            </section>

            <section className="future-card"><div className="future-card-head"><div><h3>备份原则</h3></div></div><div className="future-card-body backup-principles">
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">原始优先</span><b>会话保存原生文件</b></div><p>规范观测用于查看和分析，不替代原工具的会话 / 历史文件。</p></div>
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">增量复用</span><b>相同内容只保存一份</b></div><p>未变化文件直接复用已有 SHA-256 内容；只有变化文件重新读取、检查并写入。</p></div>
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">不碰凭据</span><b>默认拒绝保存秘密</b></div><p>可携带备份包不应该顺手变成凭据泄漏包。</p></div>
            </div></section>
          </aside>
        </div>
      </main>
    </div>

    {preview && <><div className="scrim show" onClick={() => setPreview(null)}/><aside className="drawer show" aria-label="恢复预演">
      <div className="dw-head"><div><div className="dw-eyebrow">恢复预演</div><div className="dw-title">快照差异 <span className={`badge ${preview.blocked ? 'warn' : 'ok'}`}>{preview.blocked ? `${preview.blocked} 项阻止` : '路径检查通过'}</span></div><div className="dw-sub">{preview.snapshotId}</div></div><button className="icon-button" onClick={() => setPreview(null)} aria-label="关闭"><UiIcon name="close" size={15}/></button></div>
      <div className="future-drawer-body">
        <section className="drawer-section"><h3>差异摘要</h3><div className="preview-summary"><span><b>{preview.unchanged}</b> 一致</span><span><b>{preview.missing}</b> 缺失</span><span><b>{preview.modified}</b> 已修改</span><span><b>{preview.blocked}</b> 阻止</span></div></section>
        <section className="drawer-section"><h3>文件</h3><div className="drawer-file-list">{preview.items.map(item => <div key={`${item.sourceId}:${item.archivePath}`} className="drawer-file preview-file"><span className={`badge ${item.status === 'blocked' ? 'err' : item.status === 'modified' ? 'warn' : item.status === 'unchanged' ? 'ok' : 'info'}`}>{previewStatusLabel(item.status)}</span><code>{item.targetPath ?? item.archivePath}</code>{item.reason && <small>{item.reason}</small>}</div>)}</div></section>
        <section className="drawer-section"><div className="future-note"><b>这里只做预演。</b> 当前版本没有直接写回接口，因此查看差异不会修改任何已检测智能体的文件。</div></section>
      </div>
    </aside></>}

    {confirmation && <><div className="scrim show backup-confirm-scrim" onClick={() => !busy && setConfirmation(null)}/><section className="backup-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="backup-confirm-title">
      <div className="backup-confirm-icon"><UiIcon name="alert" size={20}/></div>
      <div className="backup-confirm-copy">
        <span className="eyebrow">关键操作确认</span>
        <h2 id="backup-confirm-title">{confirmation.type === 'create' ? '确认创建本地快照？' : '确认导入这个备份包？'}</h2>
        {confirmation.type === 'create'
          ? <p>将把当前选中的 {selectedSources.length} 个智能体、{selectedKinds.length} 类资产写入本地备份仓。敏感信息保护保持强制开启；已有相同内容会直接复用。</p>
          : <p>文件 <b>{confirmation.file.name}</b>（{formatBytes(confirmation.file.size)}）将经过完整性校验后写入本地备份仓，不会覆盖当前智能体文件。</p>}
        <div className="backup-confirm-facts">
          {confirmation.type === 'create'
            ? <><span>约 {estimatedSelected} 条文件引用</span><span>索引 {indexTime ? formatTime(indexTime) : '准备中'}</span></>
            : <><span>只导入到本地备份仓</span><span>恢复仍需单独预演</span></>}
        </div>
        <div className="backup-confirm-actions">
          <button className="btn" disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>取消</button>
          <button className="btn primary" disabled={Boolean(busy)} onClick={() => void confirmCriticalOperation()}>{confirmation.type === 'create' ? '确认创建' : '确认导入'}</button>
        </div>
      </div>
    </section></>}
  </>
}
