import { useMemo, useState } from 'react'
import type { AgentAssetInventoryDto, AgentOverviewDto, CapturePolicyResponseDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'
import { CompactPageHeading } from '../components/CompactPageHeading'
import { IconButton, UiIcon } from '../components/ui'
import { copyText } from '../client/clipboard'

const capabilityLabel: Record<string, string> = {
  session: '会话',
  transcript: '对话记录',
  'tool-call': '工具调用',
  'tool-result': '工具结果',
  permission: '权限',
  subagent: '子智能体',
  context: '上下文',
  thinking: '可观察过程片段',
  'asset-discovery': '资产发现',
  'asset-invocation': '资产调用',
  'artifact-action': '产物操作',
  usage: '使用情况',
}

const capabilityStatusLabel: Record<string, string> = {
  available: '可用',
  partial: '部分可用',
  experimental: '实验性',
  unavailable: '不可用',
  'not-applicable': '不适用',
}

const captureModeLabel: Record<string, string> = {
  history: '历史记录',
  'runtime-hook': '运行时钩子',
  'native-tail': '原生实时跟踪',
  'static-scan': '静态扫描',
}

const stateLabel: Record<string, string> = {
  installed: '已安装',
  configured: '已配置',
  enabled: '已启用',
  discoverable: '可发现',
  exposed: '已开放',
  invoked: '已调用',
  observed: '已观测',
}

const negativeStateLabel: Record<string, string> = {
  installed: '未安装',
  configured: '未配置',
  enabled: '未启用',
  discoverable: '不可发现',
  exposed: '未开放',
  invoked: '未观察到使用',
  observed: '未观察到',
}

const assetTypeLabel: Record<string, string> = {
  skill: '技能',
  mcp: 'MCP（模型上下文协议）',
  plugin: '插件',
  extension: '扩展',
  hook: '钩子',
  memory: '记忆',
  rule: '规则',
  builtin: '内建能力',
  unknown: '其他',
}

const assetTypeOrder = ['skill', 'mcp', 'plugin', 'extension', 'hook', 'memory', 'rule', 'builtin', 'unknown']
const USER_ASSET_LIMIT = 24
const ASSEMBLY_PATH_LIMIT = 18

const agentDescription: Record<string, string> = {
  codex: 'OpenAI Codex · 本机历史、运行时钩子与能力资产',
  'claude-code': 'Anthropic Claude Code · 会话、钩子与能力资产',
  pi: 'Pi · 原生会话、分支关系与能力资产',
  hermes: 'Hermes · 本机会话、观察器与能力资产',
  opencode: 'OpenCode · 本机会话、原生记录与能力资产',
}

function captureState(agent: Pick<AgentOverviewDto, 'supported' | 'enabled' | 'detected'>): { label: string; title: string; className: string } {
  if (!agent.supported) return { label: '未支持', title: '当前版本未声明支持该智能体', className: 'is-unsupported' }
  if (!agent.detected) return { label: agent.enabled ? '未检测 · 已启用采集' : '未检测 · 未启用采集', title: agent.enabled ? '已允许采集，但本机尚未检测到该智能体' : '本机尚未检测到该智能体，当前也未启用采集', className: agent.enabled ? 'is-enabled' : 'is-disabled' }
  if (!agent.enabled) return { label: '已检测 · 未启用采集', title: '本机已检测到该智能体，但当前采集策略未启用此来源', className: 'is-disabled' }
  return { label: '已检测 · 采集中', title: '本机已检测到该智能体，且当前采集策略已启用此来源', className: 'is-enabled is-detected' }
}

function capabilityDetail(cap: AgentOverviewDto['capabilities'][number]): string {
  const modes = cap.captureModes.map(mode => captureModeLabel[mode] ?? mode)
  const parts = [modes.length ? `采集：${modes.join(' / ')}` : '采集：未声明']
  if (cap.reason) parts.push(`说明：${cap.reason}`)
  return parts.join(' · ')
}

function shortPath(path: string, max = 58): string {
  if (path.length <= max) return path
  const left = Math.max(16, Math.floor(max * 0.38))
  const right = Math.max(24, max - left - 1)
  return `${path.slice(0, left)}…${path.slice(-right)}`
}

function assetUsageCount(agent: AgentOverviewDto, asset: AgentAssetInventoryDto): number {
  return agent.usedAssets
    .filter(item => item.type === asset.type && item.canonicalName === asset.canonicalName)
    .reduce((sum, item) => sum + item.callCount, 0)
}

function summarizedStates(asset: AgentAssetInventoryDto): Array<{ state: string; value: boolean | 'unknown' }> {
  const states = new Map<string, boolean | 'unknown'>()
  for (const binding of asset.bindings) {
    for (const item of binding.states) {
      const current = states.get(item.state)
      if (item.value === true || current === undefined) states.set(item.state, item.value)
      else if (item.value === false && current === 'unknown') states.set(item.state, false)
    }
  }
  return [...states].map(([state, value]) => ({ state, value }))
}

function stateValue(asset: AgentAssetInventoryDto, state: string): boolean | 'unknown' | undefined {
  return summarizedStates(asset).find(item => item.state === state)?.value
}

function StateBadge({ state, value }: { state: string; value: boolean | 'unknown' }) {
  const positive = stateLabel[state] ?? state
  const label = value === 'unknown' ? `${positive}状态未知` : value ? positive : negativeStateLabel[state] ?? `非${positive}`
  return <span className="asset-state" data-value={String(value)}>{label}</span>
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await copyText(path)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }
  return <button className="copy-link" onClick={() => void copy()}>{copied ? '已复制' : '复制'}</button>
}

function AssetCard({ agent, asset }: { agent: AgentOverviewDto; asset: AgentAssetInventoryDto }) {
  const usage = assetUsageCount(agent, asset)
  const path = asset.bindings.find(item => item.path)?.path
  const states = summarizedStates(asset)
  return <div className="asset-item">
    <div className="asset-item-head">
      <span className="asset-type">{assetTypeLabel[asset.type] ?? asset.type}</span>
      {usage > 0 && <span className="asset-usage">{usage} 次真实调用</span>}
    </div>
    <div className="asset-name" title={asset.displayName ?? asset.canonicalName}>{asset.displayName ?? asset.canonicalName}</div>
    <div className="asset-states">
      {states.length ? <>{states.slice(0, 3).map(item => <StateBadge key={item.state} state={item.state} value={item.value}/>)}{states.length > 3 && <span className="asset-more-state">+{states.length - 3}</span>}</> : <span className="asset-discovered">已发现</span>}
    </div>
    {path && <div className="asset-path"><code title={path}>{shortPath(path)}</code><CopyPath path={path}/></div>}
  </div>
}

function AssetGroup({ agent, type, assets }: { agent: AgentOverviewDto; type: string; assets: AgentAssetInventoryDto[] }) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? assets : assets.slice(0, USER_ASSET_LIMIT)
  return <details className="disclosure-group">
    <summary><span>{assetTypeLabel[type] ?? type}</span><span className="disclosure-count">{assets.length}</span></summary>
    <div className="asset-list-grid">{shown.map(asset => <AssetCard key={asset.id} agent={agent} asset={asset}/>)}</div>
    {assets.length > USER_ASSET_LIMIT && <button className="show-more-button" onClick={() => setShowAll(value => !value)}>{showAll ? '收起' : `查看更多 ${assets.length - USER_ASSET_LIMIT} 个`}</button>}
  </details>
}

function FrequentAssets({ agent, assets }: { agent: AgentOverviewDto; assets: AgentAssetInventoryDto[] }) {
  if (!assets.length) return <div className="muted-empty compact">暂无能够可靠归因的技能或 MCP（模型上下文协议）使用记录</div>
  const rows = assets.map(asset => ({ asset, count: assetUsageCount(agent, asset) }))
  const max = Math.max(1, ...rows.map(row => row.count))
  return <div className="frequent-assets">
    {rows.map(({ asset, count }, index) => <div key={asset.id} className="frequent-asset-row">
      <span className="frequent-rank">{index + 1}</span>
      <div className="frequent-main"><b>{asset.displayName ?? asset.canonicalName}</b><span>{assetTypeLabel[asset.type] ?? asset.type}</span></div>
      <span className="frequent-usage-track" aria-hidden="true"><i style={{ width: `${Math.max(4, count / max * 100)}%` }}/></span>
      <strong>{count}</strong>
    </div>)}
  </div>
}

function SkillLifecycle({ agent, skills }: { agent: AgentOverviewDto; skills: AgentAssetInventoryDto[] }) {
  if (!skills.length) return null
  const installedReported = skills.some(asset => stateValue(asset, 'installed') !== undefined)
  const installed = installedReported ? skills.filter(asset => stateValue(asset, 'installed') === true).length : skills.length
  const discoverableReported = skills.some(asset => stateValue(asset, 'discoverable') !== undefined)
  const discoverable = skills.filter(asset => stateValue(asset, 'discoverable') === true).length
  const used = skills.filter(asset => assetUsageCount(agent, asset) > 0).length
  const baseline = Math.max(1, installed)
  const rows = [
    { key: 'installed', label: installedReported ? '已安装' : '已发现', value: installed, percent: 100, active: false },
    { key: 'discoverable', label: discoverableReported ? '可发现' : '可发现状态未报告', value: discoverableReported ? discoverable : null, percent: discoverableReported ? Math.min(100, discoverable / baseline * 100) : 0, active: false },
    { key: 'used', label: '已使用', value: used, percent: Math.min(100, used / baseline * 100), active: true },
  ]

  return <section className="skill-lifecycle">
    <div className="section-heading-row"><div><h3>技能生命周期</h3><p>从本机资产发现，到智能体可发现，再到有证据支撑的真实调用。</p></div></div>
    <div className="skill-funnel">
      {rows.map(row => <div key={row.key} className="skill-funnel-row" data-active={row.active || undefined} data-muted={row.value === null || undefined}>
        <span>{row.label}</span>
        <span className="skill-funnel-track" aria-hidden="true"><i style={{ width: `${Math.max(row.value === null ? 0 : 4, row.percent)}%` }}/></span>
        <strong>{row.value ?? '—'}</strong>
      </div>)}
    </div>
    {!discoverableReported && <p className="skill-funnel-note">数据源没有明确报告“可发现”状态时，不把“未报告”误算成 0。</p>}
  </section>
}

function SourceCaptureControl({
  agent,
  policy,
  onChange,
}: {
  agent: AgentOverviewDto
  policy: CapturePolicyResponseDto | null
  onChange(sourceId: string, enabled: boolean): Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const settings = policy?.settings
  const configured = settings?.configuredEnabledSources.includes(agent.sourceId) ?? agent.enabled
  const effective = settings?.effectiveEnabledSources.includes(agent.sourceId) ?? agent.enabled
  const pending = configured !== effective
  const editable = settings?.editable ?? false

  const toggle = async () => {
    if (!editable || saving) return
    setSaving(true)
    setError('')
    try {
      await onChange(agent.sourceId, !configured)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return <section className="source-capture-control">
    <div>
      <h3>用户级采集</h3>
      <p>{pending
        ? `已保存为${configured ? '开启' : '关闭'}；重启 AgentLens 运行时后完全生效。Hook 会从下一次调用起读取新设置。`
        : configured
          ? '允许 AgentLens 采集此来源的新任务、工具事件与资产；正文仍受独立隐私档位保护。'
          : 'AgentLens 不会启动此来源的历史、运行时或资产采集。已有数据不会自动删除。'}</p>
      {!editable && settings && <p className="source-capture-note">当前由{settings.managedBy === 'environment' ? '兼容环境变量' : '运行时配置'}管理，界面只读。</p>}
      {error && <p className="source-capture-error">{error}</p>}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={configured}
      className="source-capture-switch"
      data-enabled={configured || undefined}
      disabled={!editable || saving}
      onClick={() => void toggle()}
    ><span aria-hidden="true"/><b>{saving ? '保存中' : configured ? '已开启' : '已关闭'}</b></button>
  </section>
}

function AgentCard({ agent, policy, onCaptureChange }: {
  agent: AgentOverviewDto
  policy: CapturePolicyResponseDto | null
  onCaptureChange(sourceId: string, enabled: boolean): Promise<void>
}) {
  const [showAllBindings, setShowAllBindings] = useState(false)
  const installation = agent.installations[0]
  const grouped = useMemo(() => {
    const map = new Map<string, AgentAssetInventoryDto[]>()
    for (const asset of agent.assetInventory) {
      const list = map.get(asset.type) ?? []
      list.push(asset)
      map.set(asset.type, list)
    }
    return assetTypeOrder.map(type => [type, map.get(type) ?? []] as const).filter(([, items]) => items.length > 0)
  }, [agent.assetInventory])

  const userGrouped = grouped.filter(([type]) => type !== 'builtin')
  const builtinAssets = grouped.find(([type]) => type === 'builtin')?.[1] ?? []
  const skillAssets = grouped.find(([type]) => type === 'skill')?.[1] ?? []
  const priorityAssets = useMemo(() => [...agent.assetInventory]
    .map(asset => ({ asset, usage: assetUsageCount(agent, asset) }))
    .filter(item => item.usage > 0 && (item.asset.type === 'skill' || item.asset.type === 'mcp'))
    .sort((a, b) => b.usage - a.usage || (a.asset.displayName ?? a.asset.canonicalName).localeCompare(b.asset.displayName ?? b.asset.canonicalName))
    .slice(0, 6)
    .map(item => item.asset), [agent])

  const bindings = agent.assetInventory.flatMap(asset => asset.bindings.map(binding => ({ asset, binding })))
  const visibleBindings = showAllBindings ? bindings : bindings.slice(0, ASSEMBLY_PATH_LIMIT)
  const userAssetCount = userGrouped.reduce((sum, [, assets]) => sum + assets.length, 0)
  const userUsageCount = agent.usedAssets.reduce((sum, item) => sum + item.callCount, 0)
  const status = captureState(agent)

  return <article className="agent-card" data-source={agent.sourceId} data-enabled={String(agent.enabled)}>
    <header className="agent-card-head">
      <div className="agent-identity">
        <span className={`source-dot large ${sourceDot(agent.sourceId)}`}/>
        <div><h2>{agentLabel(agent.sourceId, agent.displayName)}</h2><p>{agentDescription[agent.sourceId] ?? '本机智能体的安装、资产与使用情况'}</p></div>
      </div>
      <span className={`agent-status ${status.className}`} title={status.title}>{status.label}</span>
    </header>

    <div className="agent-installation">
      <span><small>版本</small><b>{installation?.version ?? (agent.detected ? '版本未取得' : '未检测')}</b></span>
      <span className="agent-config"><small>配置目录</small><code title={installation?.configRoot}>{installation?.configRoot ? shortPath(installation.configRoot, 52) : agent.detected ? '路径未取得' : '未检测'}</code></span>
    </div>

    <SourceCaptureControl agent={agent} policy={policy} onChange={onCaptureChange}/>

    <section className="agent-primary-section">
      <div className="section-heading-row"><div><h3>我的资产</h3><p>用户安装、配置或维护的能力；内建工具单独放在后面。</p></div><span className="section-total">{userAssetCount}</span></div>
      <div className="asset-kpis">
        {userGrouped.length ? userGrouped.map(([type, items]) => <div key={type} className="asset-kpi"><strong>{items.length}</strong><span>{assetTypeLabel[type] ?? type}</span></div>) : <div className="muted-empty compact">暂无可识别的用户资产</div>}
      </div>
      {userUsageCount > 0 && <div className="reliable-usage">可靠归因调用 <b>{userUsageCount}</b> 次</div>}
    </section>

    <section className="agent-primary-section">
      <div className="section-heading-row"><div><h3>最近真正用过</h3><p>只统计有证据支撑的技能和 MCP（模型上下文协议），不把内建工具混进来。</p></div></div>
      <FrequentAssets agent={agent} assets={priorityAssets}/>
    </section>

    <SkillLifecycle agent={agent} skills={skillAssets}/>

    <section className="agent-disclosures">
      {userGrouped.map(([type, assets]) => <AssetGroup key={type} agent={agent} type={type} assets={assets}/>)}
      {agent.assetInventoryStatus === 'unavailable' && <div className="muted-empty compact">当前存储未提供资产库存查询能力</div>}
    </section>

    <section className="agent-secondary">
      {builtinAssets.length > 0 && <AssetGroup agent={agent} type="builtin" assets={builtinAssets}/>} 
      <details className="disclosure-group">
        <summary><span>装配路径</span><span className="disclosure-count">{bindings.length}</span></summary>
        <div className="assembly-list">
          {installation?.executable && <div><span>可执行文件</span><code>{installation.executable}</code></div>}
          {installation?.configRoot && <div><span>配置</span><code>{installation.configRoot}</code></div>}
          {installation?.dataRoot && <div><span>数据</span><code>{installation.dataRoot}</code></div>}
          {visibleBindings.map(({ asset, binding }) => binding.path ? <div key={binding.id}><span>{assetTypeLabel[asset.type] ?? asset.type}</span><code>{binding.path}</code></div> : null)}
          {!installation && !bindings.some(item => item.binding.path) && <div className="muted-empty compact">暂无装配路径</div>}
        </div>
        {bindings.length > ASSEMBLY_PATH_LIMIT && <button className="show-more-button" onClick={() => setShowAllBindings(value => !value)}>{showAllBindings ? '收起' : `查看更多 ${bindings.length - ASSEMBLY_PATH_LIMIT} 条路径`}</button>}
      </details>
      <details className="disclosure-group">
        <summary><span>可观测能力</span><span className="disclosure-count">{agent.capabilities.length}</span></summary>
        <div className="capability-list">
          {agent.capabilities.map(cap => <div key={cap.name} className="capability-row" title={capabilityDetail(cap)}><span>{capabilityLabel[cap.name] ?? cap.name} · {capabilityDetail(cap)}</span><b data-status={cap.status}>{capabilityStatusLabel[cap.status] ?? cap.status}</b></div>)}
        </div>
      </details>
    </section>
  </article>
}

export function AgentsPage({ model, sourceId, onSourceIdChange }: { model: AgentLensClientModel; sourceId: string; onSourceIdChange(sourceId: string): void }) {
  const snapshot = useClientSnapshot(model)
  const agents = snapshot.facets?.agents ?? []
  const items = snapshot.agents?.items ?? []
  const fallbackSourceId = items.find(item => item.detected)?.sourceId || items[0]?.sourceId || ''
  const selectedSourceId = items.some(item => item.sourceId === sourceId) ? sourceId : fallbackSourceId
  const selectedAgent = items.find(item => item.sourceId === selectedSourceId)

  return <main className="workspace-page">
    <div className="workspace-toolbar">
      <AgentScope agents={agents} value={selectedSourceId} onChange={onSourceIdChange} allLabel={false}/>
      <IconButton className="icon-button toolbar-end" onClick={() => void model.refreshFacetsAndAgents()} title="刷新智能体概览" aria-label="刷新智能体概览"><UiIcon name="refresh" size={16}/></IconButton>
    </div>
    <div className="page-content agents-content">
      <CompactPageHeading title="智能体概览" description="集中查看本机智能体、用户资产、真实使用情况和技能生命周期。已检测只表示发现了智能体，不等于已经启用采集。"/>
      {items.length ? <div className="agents-browser">
        <nav className="agent-source-nav" aria-label="智能体列表">
          <div className="agent-source-nav-head"><b>本机智能体</b><span>{items.length}</span></div>
          {items.map(agent => {
            const assetCount = agent.assetInventory.filter(asset => asset.type !== 'builtin').length
            const status = captureState(agent)
            return <button key={agent.sourceId} className={`agent-source-option ${agent.sourceId === selectedSourceId ? 'is-active' : ''}`} onClick={() => onSourceIdChange(agent.sourceId)} aria-current={agent.sourceId === selectedSourceId ? 'true' : undefined} title={status.title}>
              <span className={`source-dot large ${sourceDot(agent.sourceId)}`}/>
              <span className="agent-source-copy"><b>{agentLabel(agent.sourceId, agent.displayName)}</b><small>{assetCount} 项用户资产</small></span>
              <span className={`agent-source-state ${status.className}`}>{status.label}</span>
            </button>
          })}
        </nav>
        <div className="agent-detail-pane">{selectedAgent && <AgentCard key={selectedAgent.sourceId} agent={selectedAgent} policy={snapshot.capturePolicy} onCaptureChange={(id, enabled) => model.setSourceEnabled(id, enabled)}/>}</div>
      </div> : <div className="empty-state roomy">没有可显示的智能体</div>}
    </div>
  </main>
}
