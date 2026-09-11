import { useMemo, useState } from 'react'
import type {
  AgentAssetInventoryDto,
  AgentOverviewDto,
  CapturePolicyResponseDto,
  IntegrationAuthorizationCapabilityDto,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { agentLabel, sourceDot, useOrderedAgents } from '../components/AgentScope'
import { CompactPageHeading } from '../components/CompactPageHeading'
import { Button, Dialog, StatusBadge, Toolbar, UiIcon } from '../components/ui'
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
  available: '支持',
  partial: '部分支持',
  experimental: '实验性',
  unavailable: '暂不支持',
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
  prompt: '提示词模板',
  theme: '主题',
  context: '上下文文件',
  rule: '规则',
  builtin: '内建能力',
  unknown: '其他',
}

const assetTypeOrder = ['skill', 'mcp', 'plugin', 'extension', 'prompt', 'context', 'theme', 'hook', 'memory', 'rule', 'builtin', 'unknown']
const USER_ASSET_LIMIT = 24
const ASSEMBLY_PATH_LIMIT = 18

const integrationCapabilityLabel: Record<string, string> = {
  source: 'Source',
  hook: 'Hook',
  runtime: 'Runtime',
  live: 'Live',
}

const integrationAvailabilityLabel: Record<string, string> = {
  available: '可用',
  partial: '部分可用',
  unavailable: '不可用',
  error: '异常',
}

function integrationAvailabilityTone(
  availability: string,
): 'success' | 'warning' | 'danger' | 'neutral' {
  if (availability === 'available') return 'success'
  if (availability === 'partial' || availability === 'unavailable') return 'warning'
  if (availability === 'error') return 'danger'
  return 'neutral'
}

const agentDescription: Record<string, string> = {
  codex: 'OpenAI Codex · 本机历史、运行时钩子与能力资产',
  'claude-code': 'Anthropic Claude Code · 会话、钩子与能力资产',
  pi: 'Pi · 原生会话、分支关系与能力资产',
  hermes: 'Hermes · 本机会话、观察器与能力资产',
  opencode: 'OpenCode · 本机会话、原生记录与能力资产',
}

function captureState(agent: Pick<AgentOverviewDto, 'supported' | 'enabled' | 'detected'>): { label: string; title: string; className: string } {
  if (!agent.supported) return { label: '未支持', title: '当前版本未声明支持该智能体', className: 'is-unsupported' }
  if (!agent.detected) return { label: agent.enabled ? '未检测 · 已启用' : '未检测 · 未启用', title: agent.enabled ? '该智能体集成已启用，但本机尚未检测到对应产品或数据' : '本机尚未检测到该智能体，集成当前也未启用', className: agent.enabled ? 'is-enabled' : 'is-disabled' }
  if (!agent.enabled) return { label: '已检测 · 未启用', title: '本机已检测到该智能体，但当前没有启用此智能体集成', className: 'is-disabled' }
  return { label: '已检测 · 已启用', title: '本机已检测到该智能体，且对应 AgentLens 集成已启用', className: 'is-enabled is-detected' }
}

function capabilityDetail(cap: AgentOverviewDto['capabilities'][number]): string {
  const modes = cap.captureModes.map(mode => captureModeLabel[mode] ?? mode)
  const parts = [modes.length ? `采集方式：${modes.join(' / ')}` : '采集方式：未声明']
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

function DisclosureChevron() {
  return <UiIcon className="disclosure-chevron" name="chevron-right" size={14}/>
}

function AssetGroup({ agent, type, assets }: { agent: AgentOverviewDto; type: string; assets: AgentAssetInventoryDto[] }) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? assets : assets.slice(0, USER_ASSET_LIMIT)
  return <details className="disclosure-group">
    <summary><DisclosureChevron/><span>{assetTypeLabel[type] ?? type}</span><span className="disclosure-count">{assets.length}</span></summary>
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
  const discoverableKnown = skills.some(asset => {
    const value = stateValue(asset, 'discoverable')
    return value === true || value === false
  })
  const discoverable = discoverableKnown
    ? skills.filter(asset => stateValue(asset, 'discoverable') === true).length
    : null
  const used = skills.filter(asset => assetUsageCount(agent, asset) > 0).length
  const baseline = Math.max(1, installed)
  const rows = [
    { key: 'installed', label: installedReported ? '已安装' : '已发现', value: installed, percent: 100, active: false },
    { key: 'discoverable', label: discoverableKnown ? '可发现' : '可发现状态未知', value: discoverable, percent: discoverable === null ? 0 : Math.min(100, discoverable / baseline * 100), active: false },
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
    {!discoverableKnown && <p className="skill-funnel-note">数据源没有证据确认“可发现”真值时，保持未知，不把未知误算成 0。</p>}
  </section>
}

function IntegrationControl({
  agent,
  policy,
  onChange,
  onAuthorize,
}: {
  agent: AgentOverviewDto
  policy: CapturePolicyResponseDto | null
  onChange(sourceId: string, enabled: boolean): Promise<void>
  onAuthorize(
    productId: string,
    capabilities: readonly IntegrationAuthorizationCapabilityDto[],
  ): Promise<unknown>
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [authorizationOpen, setAuthorizationOpen] = useState(false)
  const [authorizationSaved, setAuthorizationSaved] = useState(false)
  const settings = policy?.settings
  const configured = settings?.configuredEnabledSources.includes(agent.sourceId) ?? agent.enabled
  const effective = settings?.effectiveEnabledSources.includes(agent.sourceId) ?? agent.enabled
  const pending = configured !== effective
  const editable = settings?.editable ?? false
  const pendingAuthorization = (agent.integration?.capabilities ?? [])
    .filter(item => item.authorization === 'required')
    .map(item => item.capability)
    .filter((capability): capability is IntegrationAuthorizationCapabilityDto =>
      capability === 'hook' || capability === 'runtime' || capability === 'live'
    )

  const persistEnabled = async (enabled: boolean) => {
    setSaving(true)
    setError('')
    try {
      await onChange(agent.sourceId, enabled)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const toggle = () => {
    if (!editable || saving) return
    if (!configured && pendingAuthorization.length) {
      setAuthorizationOpen(true)
      return
    }
    void persistEnabled(!configured)
  }

  const authorize = async () => {
    if (!pendingAuthorization.length || saving) return
    setSaving(true)
    setError('')
    try {
      await onAuthorize(agent.productId, pendingAuthorization)
      if (!configured) await onChange(agent.sourceId, true)
      setAuthorizationSaved(true)
      setAuthorizationOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return <section className="source-capture-control">
    <div>
      <h3>智能体集成</h3>
      <p>{pending
        ? `已保存为${configured ? '开启' : '关闭'}；Hook 会从下一次调用起读取新设置，Live / Runtime 在重启 AgentLens 后完全生效。`
        : configured
          ? '启用此智能体在 AgentLens 中声明的 Source / Hook / Runtime / Live 能力；具体可用能力取决于该智能体集成。'
          : '不会启动此智能体的新采集、Hook 处理或 Live / Runtime 控制能力；已有历史数据不会删除。'}</p>
      {agent.integration && <div className="integration-availability">
        <span className="integration-availability-overall">
          <small>当前可用性</small>
          <StatusBadge tone={integrationAvailabilityTone(agent.integration.availability)} dot>
            {integrationAvailabilityLabel[agent.integration.availability] ?? agent.integration.availability}
          </StatusBadge>
        </span>
        <span className="integration-capability-badges">
          {agent.integration.capabilities.map(item => <StatusBadge
            key={item.capability}
            tone={integrationAvailabilityTone(item.availability)}
            title={item.reason}
          >{integrationCapabilityLabel[item.capability] ?? item.capability} · {item.authorization === 'required' ? '待授权' : integrationAvailabilityLabel[item.availability] ?? item.availability}</StatusBadge>)}
        </span>
      </div>}
      {configured && pendingAuthorization.length > 0 && !authorizationSaved && <div className="integration-authorization-action">
        <Button size="small" disabled={!editable || saving} onClick={() => setAuthorizationOpen(true)}>授权控制能力</Button>
        <span>Runtime / Live 等主动控制能力尚未授权，不会启动。</span>
      </div>}
      {authorizationSaved && <p className="source-capture-note">授权已保存；重启 AgentLens 后控制能力生效。</p>}
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
      onClick={toggle}
    ><span aria-hidden="true"/><b>{saving ? '保存中' : configured ? '已开启' : '已关闭'}</b></button>
    <Dialog
      open={authorizationOpen}
      title={`授权 ${agentLabel(agent.sourceId, agent.displayName)} 控制能力`}
      description="Source 只读检测与历史采集不需要这项授权；以下能力可能启动智能体运行时或建立实时控制连接。"
      onClose={() => { if (!saving) setAuthorizationOpen(false) }}
      closeDisabled={saving}
      footer={<>
        <Button disabled={saving} onClick={() => setAuthorizationOpen(false)}>取消</Button>
        <Button variant="primary" loading={saving} onClick={() => void authorize()}>确认授权并启用</Button>
      </>}
    >
      <div className="integration-authorization-list">
        {pendingAuthorization.map(capability => <div key={capability}>
          <b>{integrationCapabilityLabel[capability] ?? capability}</b>
          <span>{capability === 'runtime'
            ? '允许 AgentLens 启动并管理该智能体的运行会话。'
            : capability === 'live'
              ? '允许 AgentLens 建立实时消息、流式事件与中断控制。'
              : '允许 AgentLens 写入或启用该智能体的观察 Hook。'}</span>
        </div>)}
      </div>
      <p className="integration-authorization-note">授权会持久化保存；以后关闭再开启不会重复询问。禁用集成不会删除历史数据。</p>
    </Dialog>
  </section>
}

function AgentCard({ agent, policy, onCaptureChange, onAuthorize }: {
  agent: AgentOverviewDto
  policy: CapturePolicyResponseDto | null
  onCaptureChange(sourceId: string, enabled: boolean): Promise<void>
  onAuthorize(
    productId: string,
    capabilities: readonly IntegrationAuthorizationCapabilityDto[],
  ): Promise<unknown>
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

    <IntegrationControl agent={agent} policy={policy} onChange={onCaptureChange} onAuthorize={onAuthorize}/>

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
        <summary><DisclosureChevron/><span>装配路径</span><span className="disclosure-count">{bindings.length}</span></summary>
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
        <summary title="这里展示的是 AgentLens 适配器声明的采集支持，不代表当前智能体安装实例自报告的产品能力。"><DisclosureChevron/><span>AgentLens 采集支持</span><span className="disclosure-count">{agent.capabilities.length}</span></summary>
        <div className="capability-list">
          {agent.capabilities.map(cap => <div key={cap.name} className="capability-row" title={capabilityDetail(cap)}><span>{capabilityLabel[cap.name] ?? cap.name} · {capabilityDetail(cap)}</span><b data-status={cap.status}>{capabilityStatusLabel[cap.status] ?? cap.status}</b></div>)}
        </div>
      </details>
    </section>
  </article>
}

export function AgentsPage({ model, sourceId, onSourceIdChange }: { model: AgentLensClientModel; sourceId: string; onSourceIdChange(sourceId: string): void }) {
  const snapshot = useClientSnapshot(model)
  const agents = useOrderedAgents(snapshot.facets?.agents ?? [])
  const items = useOrderedAgents(snapshot.agents?.items ?? [])
  const fallbackSourceId = items.find(item => item.detected)?.sourceId || items[0]?.sourceId || ''
  const selectedSourceId = items.some(item => item.sourceId === sourceId) ? sourceId : fallbackSourceId
  const selectedAgent = items.find(item => item.sourceId === selectedSourceId)
  const rescan = snapshot.agentsRescanResult
  const rescanStatus = snapshot.agentsRescanning
    ? <StatusBadge tone="accent" dot>正在重新扫描本机智能体与资产</StatusBadge>
    : snapshot.agentsRescanError
      ? <StatusBadge tone="danger" title={snapshot.agentsRescanError}>重新扫描失败</StatusBadge>
      : rescan
        ? <StatusBadge tone={rescan.status === 'completed' ? 'success' : 'danger'} title={rescan.failures.map(item => `${item.sourceId}: ${item.message}`).join('\n') || undefined}>
            {rescan.status === 'completed'
              ? `扫描完成 · ${rescan.sourcesDetected} 个来源 · ${rescan.assetsDiscovered} 项资产${rescan.assetsRemoved ? ` · ${rescan.assetsRemoved} 项已移除` : ''}`
              : `扫描${rescan.status === 'partial' ? '部分完成' : '失败'} · ${rescan.failures.length} 个来源异常`}
          </StatusBadge>
        : null

  return <main className="workspace-page">
    <div className="page-content agents-content">
      <CompactPageHeading title="智能体概览" description="集中查看本机智能体、集成状态、用户资产、真实使用情况和技能生命周期。已检测只表示发现了智能体，不等于已经启用对应集成。">
        <Toolbar aria-label="智能体扫描" className="agents-rescan-toolbar">
          <Button size="small" loading={snapshot.agentsRescanning} disabled={snapshot.agentsRescanning} onClick={() => void model.rescanAgents().catch(() => undefined)}><UiIcon name="refresh" size={14}/>{snapshot.agentsRescanning ? '正在扫描…' : '重新扫描'}</Button>
          {rescanStatus}
        </Toolbar>
      </CompactPageHeading>
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
        <div className="agent-detail-pane">{selectedAgent && <AgentCard
          key={selectedAgent.sourceId}
          agent={selectedAgent}
          policy={snapshot.capturePolicy}
          onCaptureChange={(id, enabled) => model.setSourceEnabled(id, enabled)}
          onAuthorize={(productId, capabilities) => model.authorizeIntegration(productId, capabilities)}
        />}</div>
      </div> : <div className="empty-state roomy">没有可显示的智能体</div>}
    </div>
  </main>
}