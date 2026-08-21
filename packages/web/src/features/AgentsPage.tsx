import { useMemo, useState } from 'react'
import type { AgentAssetInventoryDto, AgentOverviewDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'

const capabilityLabel: Record<string, string> = {
  session: 'Session',
  transcript: '对话记录',
  'tool-call': '工具调用',
  'tool-result': '工具结果',
  permission: '权限',
  subagent: 'Subagent',
  context: '上下文',
  thinking: 'Thinking',
  'asset-discovery': '资产发现',
  'asset-invocation': '资产调用',
  'artifact-action': '产物操作',
  usage: 'Usage',
}

const stateLabel: Record<string, string> = {
  installed: '已安装',
  configured: '已配置',
  enabled: '已启用',
  discoverable: '可发现',
  exposed: '已暴露',
  invoked: '已调用',
  observed: '已观测',
}

const assetTypeLabel: Record<string, string> = {
  skill: 'Skills',
  mcp: 'MCP',
  plugin: 'Plugins',
  extension: 'Extensions',
  hook: 'Hooks',
  memory: 'Memory',
  rule: 'Rules',
  builtin: '内建能力',
  unknown: '其他',
}

const assetTypeOrder = ['skill', 'mcp', 'plugin', 'extension', 'hook', 'memory', 'rule', 'builtin', 'unknown']
const USER_ASSET_LIMIT = 24
const ASSEMBLY_PATH_LIMIT = 18

const agentDescription: Record<string, string> = {
  codex: 'OpenAI Codex · 本机历史、Runtime Hook 与能力资产',
  'claude-code': 'Anthropic Claude Code · Session、Hook 与能力资产',
  pi: 'Pi · 原生 Session、分支关系与能力资产',
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

function StateBadge({ state, value }: { state: string; value: boolean | 'unknown' }) {
  return <span className="asset-state" data-value={String(value)}>{stateLabel[state] ?? state}{value === 'unknown' ? ' 未知' : value ? '' : ' 否'}</span>
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path)
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
      {usage > 0 && <span className="asset-usage">{usage} 次</span>}
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
  if (!assets.length) return <div className="muted-empty compact">暂无能够可靠归因的 Skill / MCP 使用记录</div>
  return <div className="frequent-assets">
    {assets.map((asset, index) => <div key={asset.id} className="frequent-asset-row">
      <span className="frequent-rank">{index + 1}</span>
      <div className="frequent-main"><b>{asset.displayName ?? asset.canonicalName}</b><span>{assetTypeLabel[asset.type] ?? asset.type}</span></div>
      <strong>{assetUsageCount(agent, asset)}</strong>
      <small>次</small>
    </div>)}
  </div>
}

function AgentCard({ agent }: { agent: AgentOverviewDto }) {
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
  const priorityAssets = useMemo(() => [...agent.assetInventory]
    .map(asset => ({ asset, usage: assetUsageCount(agent, asset) }))
    .filter(item => item.usage > 0)
    .sort((a, b) => b.usage - a.usage || (a.asset.displayName ?? a.asset.canonicalName).localeCompare(b.asset.displayName ?? b.asset.canonicalName))
    .slice(0, 5)
    .map(item => item.asset), [agent])

  const bindings = agent.assetInventory.flatMap(asset => asset.bindings.map(binding => ({ asset, binding })))
  const visibleBindings = showAllBindings ? bindings : bindings.slice(0, ASSEMBLY_PATH_LIMIT)
  const userAssetCount = userGrouped.reduce((sum, [, assets]) => sum + assets.length, 0)
  const userUsageCount = agent.usedAssets.reduce((sum, item) => sum + item.callCount, 0)

  return <article className="agent-card" data-source={agent.sourceId}>
    <header className="agent-card-head">
      <div className="agent-identity">
        <span className={`source-dot large ${sourceDot(agent.sourceId)}`}/>
        <div><h2>{agentLabel(agent.sourceId, agent.displayName)}</h2><p>{agentDescription[agent.sourceId] ?? '本机 Agent 的安装、资产与使用情况'}</p></div>
      </div>
      <span className={`agent-status ${agent.detected ? 'is-detected' : ''}`}>{agent.detected ? '已检测' : '未检测'}</span>
    </header>

    <div className="agent-installation">
      <span><small>版本</small><b>{installation?.version ?? '未检测'}</b></span>
      <span className="agent-config"><small>配置目录</small><code title={installation?.configRoot}>{installation?.configRoot ? shortPath(installation.configRoot, 52) : '未检测'}</code></span>
    </div>

    <section className="agent-primary-section">
      <div className="section-heading-row"><div><h3>我的资产</h3><p>用户安装、配置或维护的能力</p></div><span className="section-total">{userAssetCount}</span></div>
      <div className="asset-kpis">
        {userGrouped.length ? userGrouped.map(([type, items]) => <div key={type} className="asset-kpi"><strong>{items.length}</strong><span>{assetTypeLabel[type] ?? type}</span></div>) : <div className="muted-empty compact">暂无可识别的用户资产</div>}
      </div>
      {userUsageCount > 0 && <div className="reliable-usage">可靠归因调用 <b>{userUsageCount}</b> 次</div>}
    </section>

    <section className="agent-primary-section">
      <div className="section-heading-row"><div><h3>最近真正用过</h3><p>仅展示有 Evidence 支撑的 Skill / MCP</p></div></div>
      <FrequentAssets agent={agent} assets={priorityAssets}/>
    </section>

    <section className="agent-disclosures">
      {userGrouped.map(([type, assets]) => <AssetGroup key={type} agent={agent} type={type} assets={assets}/>)}
      {agent.assetInventoryStatus === 'unavailable' && <div className="muted-empty compact">当前 Storage 未提供资产库存查询能力</div>}
    </section>

    <section className="agent-secondary">
      {builtinAssets.length > 0 && <AssetGroup agent={agent} type="builtin" assets={builtinAssets}/>} 
      <details className="disclosure-group">
        <summary><span>装配路径</span><span className="disclosure-count">{bindings.length}</span></summary>
        <div className="assembly-list">
          {installation?.executable && <div><span>Executable</span><code>{installation.executable}</code></div>}
          {installation?.configRoot && <div><span>Config</span><code>{installation.configRoot}</code></div>}
          {installation?.dataRoot && <div><span>Data</span><code>{installation.dataRoot}</code></div>}
          {visibleBindings.map(({ asset, binding }) => binding.path ? <div key={binding.id}><span>{assetTypeLabel[asset.type] ?? asset.type}</span><code>{binding.path}</code></div> : null)}
          {!installation && !bindings.some(item => item.binding.path) && <div className="muted-empty compact">暂无装配路径</div>}
        </div>
        {bindings.length > ASSEMBLY_PATH_LIMIT && <button className="show-more-button" onClick={() => setShowAllBindings(value => !value)}>{showAllBindings ? '收起' : `查看更多 ${bindings.length - ASSEMBLY_PATH_LIMIT} 条路径`}</button>}
      </details>
      <details className="disclosure-group">
        <summary><span>可观测能力</span><span className="disclosure-count">{agent.capabilities.length}</span></summary>
        <div className="capability-list">
          {agent.capabilities.map(cap => <div key={cap.name} className="capability-row" title={cap.reason}><span>{capabilityLabel[cap.name] ?? cap.name}</span><b data-status={cap.status}>{cap.status}</b></div>)}
        </div>
      </details>
    </section>
  </article>
}

export function AgentsPage({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const agents = snapshot.facets?.agents ?? []
  const items = snapshot.agents?.items ?? []
  const [sourceId, setSourceId] = useState('')
  const shown = sourceId ? items.filter(item => item.sourceId === sourceId) : items

  return <main className="workspace-page">
    <div className="workspace-toolbar">
      <AgentScope agents={agents} value={sourceId} onChange={setSourceId}/>
      <button className="icon-button toolbar-end" onClick={() => void model.refreshFacetsAndAgents()} title="刷新 Agent 概览" aria-label="刷新 Agent 概览">↻</button>
    </div>
    <div className="page-content agents-content">
      <header className="page-heading"><div><span className="eyebrow">Workspace</span><h1>Agent 概览</h1><p>看清自己的 AI 资产、真实使用和 Agent 装配情况。</p></div></header>
      <div className="agents-grid">{shown.map(agent => <AgentCard key={agent.sourceId} agent={agent}/>)}</div>
      {!shown.length && <div className="empty-state roomy">没有可显示的 Agent</div>}
    </div>
  </main>
}
