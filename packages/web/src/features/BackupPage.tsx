import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type {
  BackupAssetKindDto,
  BackupOverviewResponseDto,
  BackupRestorePreviewResponseDto,
  BackupVerifyResponseDto,
} from '@agent-lens/protocol'
import { AgentLensApi } from '../client/api'
import { WorkspaceSkeleton } from '../components/StateViews'

const ALL_KINDS: BackupAssetKindDto[] = [
  'skill', 'mcp', 'plugin', 'extension', 'hook', 'memory', 'rule', 'session', 'config', 'other',
]

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
  return 'dot-none'
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
  const selectionInitialized = useRef(false)
  const importInput = useRef<HTMLInputElement>(null)

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      const next = await api.backupOverview()
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

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busy) return
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

  if (loading && !overview) return <WorkspaceSkeleton />

  return <>
    <div className="workspace-toolbar">
      <div className="agent-scope">
        <button className={`scope-chip ${selectedSources.length === sources.filter(source => source.detected).length ? 'active' : ''}`} onClick={() => setSelectedSources(sources.filter(source => source.detected).map(source => source.sourceId))}>全部智能体</button>
        {sources.map(source => <button key={source.sourceId} disabled={!source.detected} className={`scope-chip ${selectedSources.includes(source.sourceId) ? 'active' : ''}`} onClick={() => toggleSource(source.sourceId)}>
          <span className={`src-dot ${sourceDotClass(source.sourceId)}`}/>{source.displayName}
        </button>)}
      </div>
      <span className="toolbar-divider"/>
      <span className="backup-toolbar-note">默认排除凭据、令牌与私钥</span>
      <button className="btn toolbar-end" disabled={Boolean(busy)} onClick={() => importInput.current?.click()}>{busy === 'import' ? '正在导入…' : '↑ 导入备份包'}</button>
      <button className="btn primary" disabled={Boolean(busy) || !selectedSources.length || !selectedKinds.length} onClick={() => void createSnapshot()}>{busy === 'create' ? '正在创建…' : '＋ 创建快照'}</button>
      <input ref={importInput} className="backup-file-input" type="file" accept=".agentlens-backup,application/vnd.agentlens.backup" onChange={event => void importBackup(event)}/>
    </div>

    <div className="page-scroll">
      <main className="future-content backup-page">
        <header className="future-heading">
          <div>
            <span className="eyebrow">AI 资产保险库 <span className="prototype-flag live">本地真实数据</span></span>
            <h1>资产备份</h1>
            <p>把各智能体的原始会话和已发现资产保存为本地不可变快照。Manifest（清单）和 SHA-256 用于完整性校验；导入不会直接覆盖当前文件，恢复必须先经过预演。</p>
          </div>
          <button className="btn" disabled={loading || Boolean(busy)} onClick={() => void refresh()}>↻ 刷新扫描</button>
        </header>

        {error && <div className="backup-error" role="alert"><b>操作失败</b><span>{error}</span><button className="link-btn" onClick={() => setError('')}>关闭</button></div>}

        <section className="future-kpis" aria-label="备份概览">
          <article className="future-kpi"><div className="future-kpi-head"><span>可备份源文件</span><span className="badge ok">已扫描</span></div><strong>{protectedFiles}</strong><small>{sources.filter(source => source.detected).length} 个智能体提供原始会话或资产路径</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>本地快照</span><span className="delta neutral">{snapshots[0] ? `最近 ${formatTime(snapshots[0].createdAt)}` : '尚无快照'}</span></div><strong>{snapshots.length}</strong><small>总计 {formatBytes(totalSnapshotBytes)}</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>最近校验</span><span className={`badge ${Object.values(verification).some(result => !result.valid) ? 'err' : Object.keys(verification).length ? 'ok' : ''}`}>{Object.keys(verification).length ? (Object.values(verification).every(result => result.valid) ? '通过' : '需关注') : '未执行'}</span></div><strong>{Object.values(verification).filter(result => result.valid).length}/{Object.keys(verification).length || '—'}</strong><small>校验 Manifest 和每个快照文件的 SHA-256</small></article>
          <article className="future-kpi"><div className="future-kpi-head"><span>扫描阶段排除</span><span className="badge warn">安全优先</span></div><strong>{excludedFiles}</strong><small>符号链接、越界路径等会在扫描阶段排除；秘密内容在创建快照时继续检查</small></article>
        </section>

        <div className="future-grid">
          <div className="future-stack">
            <section className="future-card">
              <div className="future-card-head"><div><h2>保护范围</h2><p>这里展示的是 Source 当前真实暴露的原始 Session 根目录和资产绑定路径，不根据“应该安装什么”猜测。</p></div></div>
              <div className="future-card-body">
                <div className="protection-grid">
                  {sources.map(source => <article key={source.sourceId} className={`protection-card ${!source.detected ? 'is-muted' : ''}`}>
                    <div className="protection-card-head"><span className={`src-dot lg ${sourceDotClass(source.sourceId)}`}/><b>{source.displayName}</b><span className={`badge ${source.detected ? 'ok' : ''}`}>{source.detected ? '已检测' : '未检测'}</span></div>
                    <div className="protection-counts">
                      <div className="protection-count"><strong>{source.kinds.skill ?? 0}</strong><span>技能文件</span></div>
                      <div className="protection-count"><strong>{source.kinds.session ?? 0}</strong><span>会话文件</span></div>
                      <div className="protection-count"><strong>{source.fileCount}</strong><span>全部文件</span></div>
                    </div>
                    <div className="protection-meta"><span>MCP {source.kinds.mcp ?? 0} · 插件/扩展 {(source.kinds.plugin ?? 0) + (source.kinds.extension ?? 0)}</span><span>{source.excludedCount ? `排除 ${source.excludedCount}` : '路径正常'}</span></div>
                  </article>)}
                </div>
                <div className="future-section-label">当前备份目录</div>
                <div className="integrity-strip"><strong>本地 Vault</strong><code>{overview?.vaultPath ?? '—'}</code><span className="grow"/><span>快照不写入规范事实表</span></div>
              </div>
            </section>

            <section className="future-card">
              <div className="future-card-head"><div><h2>最近快照</h2><p>快照创建后内容不可变；导出只是把已经校验的快照封装成可携带备份包。</p></div><button className="btn small" disabled={Boolean(busy) || !snapshots.length} onClick={() => void verifyAll()}>{busy === 'verify-all' ? '校验中…' : '验证全部'}</button></div>
              {snapshots.length ? <div className="future-table-scroll"><table className="snapshot-table"><thead><tr><th>快照</th><th>来源</th><th>大小</th><th>完整性</th><th>排除</th><th>Hash</th><th className="align-right">操作</th></tr></thead><tbody>
                {snapshots.map(snapshot => {
                  const checked = verification[snapshot.id]
                  return <tr key={snapshot.id}>
                    <td><div className="snapshot-name"><span className="snapshot-icon">{checked ? (checked.valid ? '✓' : '!') : '•'}</span><span><b>{formatTime(snapshot.createdAt)}</b><small>{snapshot.fileCount} 个文件</small></span></div></td>
                    <td>{snapshot.sourceIds.join(' · ') || '—'}</td>
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
              <div className="future-card-head"><div><h2>导入与恢复</h2><p>导入只进入本地 Vault；正式写回前必须先计算当前机器上的差异。</p></div><span className="badge info">恢复预演优先</span></div>
              <div className="future-card-body"><div className="restore-grid">
                <article className="restore-card"><h3>导入备份包</h3><p>先验证 Manifest 与文件 Hash；同名快照只有内容完全一致才允许复用。</p><div className="restore-flow"><span className="restore-node">选择文件</span><span className="restore-arrow">→</span><span className="restore-node">完整性校验</span><span className="restore-arrow">→</span><span className="restore-node">进入 Vault</span></div><div className="restore-action"><button className="btn" disabled={Boolean(busy)} onClick={() => importInput.current?.click()}>选择备份包</button></div></article>
                <article className="restore-card"><h3>恢复到原智能体</h3><p>目标路径由当前机器重新检测的 config/data 根目录和快照相对路径计算，不信任导入包里的绝对路径。</p><div className="restore-flow"><span className="restore-node">选择快照</span><span className="restore-arrow">→</span><span className="restore-node">对比当前</span><span className="restore-arrow">→</span><span className="restore-node">人工确认</span></div><div className="restore-action"><span className="badge warn">当前版本只开放预演，不直接写回</span></div></article>
              </div></div>
            </section>
          </div>

          <aside className="future-stack">
            <section className="future-card">
              <div className="future-card-head"><div><h2>创建快照</h2><p>选择本次真正要保护的范围。</p></div><span className="badge info">本地</span></div>
              <div className="future-card-body snapshot-builder">
                <div className="builder-block"><div className="builder-label"><span>智能体</span><span>{selectedSources.length} / {sources.filter(source => source.detected).length}</span></div><div className="builder-checks">
                  {sources.filter(source => source.detected).map(source => <label key={source.sourceId} className="builder-check"><input type="checkbox" checked={selectedSources.includes(source.sourceId)} onChange={() => toggleSource(source.sourceId)}/><span className={`src-dot ${sourceDotClass(source.sourceId)}`}/>{source.displayName}<small>{source.fileCount} 文件</small></label>)}
                </div></div>
                <div className="builder-block"><div className="builder-label"><span>资产类型</span><button className="link-btn" onClick={() => setSelectedKinds(selectedKinds.length === ALL_KINDS.length ? [] : ALL_KINDS)}>{selectedKinds.length === ALL_KINDS.length ? '清空' : '全选'}</button></div><div className="builder-checks">
                  {ALL_KINDS.map(kind => <label key={kind} className="builder-check"><input type="checkbox" checked={selectedKinds.includes(kind)} onChange={() => toggleKind(kind)}/>{kindLabel(kind)}<small>{sources.filter(source => selectedSources.includes(source.sourceId)).reduce((sum, source) => sum + (source.kinds[kind] ?? 0), 0)}</small></label>)}
                </div></div>
                <div className="safety-note"><span>✓</span><div><b>敏感信息保护强制开启</b><span>第一阶段没有关闭入口。发现凭据文件名、私钥、常见 Token 或配置中的秘密赋值时，整文件排除并只记录原因。</span></div></div>
                <div className="builder-summary"><span>按分类统计约 <b>{estimatedSelected}</b> 条文件引用</span><span>重叠路径会自动去重</span></div>
                <button className="btn primary snapshot-create-button" disabled={Boolean(busy) || !selectedSources.length || !selectedKinds.length} onClick={() => void createSnapshot()}>{busy === 'create' ? '正在复制并计算 Hash…' : '创建并校验快照'}</button>
              </div>
            </section>

            <section className="future-card"><div className="future-card-head"><div><h3>备份原则</h3></div></div><div className="future-card-body backup-principles">
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">原始优先</span><b>Session 保存原生文件</b></div><p>规范观测用于查看和分析，不替代原工具的 Session / History 文件。</p></div>
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">可验证</span><b>每个文件都有 SHA-256</b></div><p>创建、导出、导入都可以重新校验，损坏不会静默跳过。</p></div>
              <div className="insight-item"><div className="insight-item-head"><span className="insight-kind fact">不碰凭据</span><b>默认拒绝保存秘密</b></div><p>可携带备份包不应该顺手变成凭据泄漏包。</p></div>
            </div></section>
          </aside>
        </div>
      </main>
    </div>

    {preview && <><div className="scrim show" onClick={() => setPreview(null)}/><aside className="drawer show" aria-label="恢复预演">
      <div className="dw-head"><div><div className="dw-eyebrow">恢复预演</div><div className="dw-title">快照差异 <span className={`badge ${preview.blocked ? 'warn' : 'ok'}`}>{preview.blocked ? `${preview.blocked} 项阻止` : '路径检查通过'}</span></div><div className="dw-sub">{preview.snapshotId}</div></div><button className="icon-button" onClick={() => setPreview(null)} aria-label="关闭">×</button></div>
      <div className="future-drawer-body">
        <section className="drawer-section"><h3>差异摘要</h3><div className="preview-summary"><span><b>{preview.unchanged}</b> 一致</span><span><b>{preview.missing}</b> 缺失</span><span><b>{preview.modified}</b> 已修改</span><span><b>{preview.blocked}</b> 阻止</span></div></section>
        <section className="drawer-section"><h3>文件</h3><div className="drawer-file-list">{preview.items.map(item => <div key={`${item.sourceId}:${item.archivePath}`} className="drawer-file preview-file"><span className={`badge ${item.status === 'blocked' ? 'err' : item.status === 'modified' ? 'warn' : item.status === 'unchanged' ? 'ok' : 'info'}`}>{previewStatusLabel(item.status)}</span><code>{item.targetPath ?? item.archivePath}</code>{item.reason && <small>{item.reason}</small>}</div>)}</div></section>
        <section className="drawer-section"><div className="future-note"><b>这里只做预演。</b> 当前版本没有直接写回接口，因此查看差异不会修改 Codex、Claude Code 或 Pi 的任何文件。</div></section>
      </div>
    </aside></>}
  </>
}
