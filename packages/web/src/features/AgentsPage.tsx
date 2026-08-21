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
  builtin: '内置能力',
  unknown: '其他',
}

const assetTypeOrder = ['skill', 'mcp', 'plugin', 'extension', 'hook', 'memory', 'rule', 'builtin', 'unknown']
const USER_ASSET_LIMIT = 24
const ASSEMBLY_PATH_LIMIT = 18

const agentDescription: Record<string, string> = {
  codex: 'OpenAI Codex 编码 Agent，本机历史、Runtime Hook 与能力资产统一观测。',
  'claude-code': 'Anthropic Claude Code，本机 Session、Hook、Skill / MCP / Plugin 等能力资产统一观测。',
  pi: 'Pi 编码 Agent，原生 Session JSONL、分支关系与能力资产统一观测。',
}

function StateBadge({ state, value }: { state: string; value: boolean | 'unknown' }) {
  const tone = value === true
    ? 'border-success/30 bg-success/10 text-success'
    : value === false
      ? 'border-danger/30 bg-danger/10 text-danger'
      : 'border-line bg-soft text-muted'
  return <span className={`rounded-md border px-1.5 py-0.5 text-[10px] ${tone}`}>
    {stateLabel[state] ?? state}{value === 'unknown' ? ' · 未知' : value ? '' : ' · 否'}
  </span>
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
  return <button className="text-[11px] text-muted hover:text-accent" onClick={() => void copy()}>
    {copied ? '已复制' : '复制'}
  </button>
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

function AssetCard({ agent, asset, priority = false }: { agent: AgentOverviewDto; asset: AgentAssetInventoryDto; priority?: boolean }) {
  const usage = assetUsageCount(agent, asset)
  const path = asset.bindings.find(item => item.path)?.path
  const states = summarizedStates(asset)
  return <div className={`asset-card ${priority ? 'asset-card-priority' : ''}`}>
    <div className="flex items-center gap-2">
      <span className="asset-type-badge">{assetTypeLabel[asset.type] ?? asset.type}</span>
      {priority && <span className="asset-priority-badge">高频</span>}
      {usage > 0 && <span className="ml-auto text-[11px] font-medium text-accent">{usage} 次</span>}
    </div>
    <div className="mt-2 truncate text-sm font-semibold" title={asset.displayName ?? asset.canonicalName}>{asset.displayName ?? asset.canonicalName}</div>
    <div className="mt-2 flex min-h-5 flex-wrap gap-1.5">
      {states.length
        ? <>{states.slice(0, 3).map(item => <StateBadge key={item.state} state={item.state} value={item.value}/>)}{states.length > 3 && <span className="text-[10px] text-muted">+{states.length - 3}</span>}</>
        : <span className="text-[11px] text-muted">已发现</span>}
    </div>
    {path && <div className="mt-2 flex items-center gap-2 border-t border-line/70 pt-2 text-[11px] text-muted">
      <span className="min-w-0 flex-1 truncate" title={path}>{shortPath(path)}</span><CopyPath path={path}/>
    </div>}
  </div>
}

function AssetGroup({ agent, type, assets }: { agent: AgentOverviewDto; type: string; assets: AgentAssetInventoryDto[] }) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? assets : assets.slice(0, USER_ASSET_LIMIT)
  return <details className="agent-group">
    <summary><span>{assetTypeLabel[type] ?? type}</span><span>{assets.length}</span></summary>
    <div className="asset-card-grid">{shown.map(asset => <AssetCard key={asset.id} agent={agent} asset={asset}/>)}</div>
    {assets.length > USER_ASSET_LIMIT && <button className="agent-group-more" onClick={() => setShowAll(value => !value)}>{showAll ? '收起' : `查看更多 ${assets.length - USER_ASSET_LIMIT} 个`}</button>}
  </details>
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
    return assetTypeOrder
      .map(type => [type, map.get(type) ?? []] as const)
      .filter(([, items]) => items.length > 0)
  }, [agent.assetInventory])

  const userGrouped = grouped.filter(([type]) => type !== 'builtin')
  const builtinAssets = grouped.find(([type]) => type === 'builtin')?.[1] ?? []

  const priorityAssets = useMemo(() => [...agent.assetInventory]
    .filter(asset => asset.type !== 'builtin')
    .map(asset => ({ asset, usage: assetUsageCount(agent, asset) }))
    .filter(item => item.usage > 0)
    .sort((a, b) => b.usage - a.usage || (a.asset.displayName ?? a.asset.canonicalName).localeCompare(b.asset.displayName ?? b.asset.canonicalName))
    .slice(0, 6), [agent])

  const builtinPriorityAssets = useMemo(() => [...agent.assetInventory]
    .filter(asset => asset.type === 'builtin')
    .map(asset => ({ asset, usage: assetUsageCount(agent, asset) }))
    .filter(item => item.usage > 0)
    .sort((a, b) => b.usage - a.usage || (a.asset.displayName ?? a.asset.canonicalName).localeCompare(b.asset.displayName ?? b.asset.canonicalName))
    .slice(0, 6), [agent])

  const bindings = agent.assetInventory.flatMap(asset => asset.bindings.map(binding => ({ asset, binding })))
  const visibleBindings = showAllBindings ? bindings : bindings.slice(0, ASSEMBLY_PATH_LIMIT)
  const userAssetCount = userGrouped.reduce((sum, [, assets]) => sum + assets.length, 0)
  const userUsageCount = agent.usedAssets.filter(item => item.type !== 'builtin').reduce((sum, item) => sum + item.callCount, 0)

  return <article className="agent-overview-card" data-source={agent.sourceId}>
    <header className="agent-overview-head">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`size-2.5 rounded-full ${sourceDot(agent.sourceId)}`}/>
          <h2 className="text-lg font-semibold">{agentLabel(agent.sourceId, agent.displayName)}</h2>
        </div>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-muted">{agentDescription[agent.sourceId] ?? '本机 Agent Source、安装状态、能力资产与实际使用情况。'}</p>
      </div>
      <span className={`agent-status ${agent.detected ? 'agent-status-ok' : ''}`}>{agent.detected ? '已检测' : '未检测'}</span>
    </header>

    <div className="agent-meta-grid">
      <div><span>版本</span><b>{installation?.version ?? '未检测'}</b></div>
      <div><span>配置目录</span><b title={installation?.configRoot}>{installation?.configRoot ? shortPath(installation.configRoot, 42) : '未检测'}</b></div>
    </div>

    <section className="agent-section">
      <div className="agent-section-heading">
        <div><div className="agent-section-title">我的资产</div><p>优先展示用户安装或配置的 Skill、MCP、Plugin 等资产。</p></div>
        <span>{userAssetCount} 个</span>
      </div>
      <div className="agent-asset-summary">
        {userGrouped.length
          ? userGrouped.map(([type, items]) => <span key={type}>{assetTypeLabel[type] ?? type} <b>{items.length}</b></span>)
          : <span>暂无可识别的用户资产</span>}
        {userUsageCount > 0 && <span className="agent-used-summary">实际调用 <b>{userUsageCount}</b></span>}
      </div>
    </section>

    <section className="agent-section">
      <div className="agent-section-title">高频用户资产</div>
      {priorityAssets.length
        ? <div className="asset-card-grid priority">{priorityAssets.map(({ asset }) => <AssetCard key={asset.id} agent={agent} asset={asset} priority/>)}</div>
        : <div className="overview-empty-line">暂无能够可靠归因的 Skill / MCP / Plugin 等高频资产</div>}
    </section>

    <section className="agent-section space-y-2">
      {userGrouped.map(([type, assets]) => <AssetGroup key={type} agent={agent} type={type} assets={assets}/>)}
      {agent.assetInventoryStatus === 'unavailable' && <div className="overview-empty-line">当前 Storage 未提供资产库存查询能力</div>}
    </section>

    {builtinAssets.length > 0 && <section className="agent-section builtin-section">
      <div className="agent-section-heading">
        <div><div className="agent-section-title">Agent 内建能力</div><p>与用户资产分开展示，主要用于理解 Agent 自身的执行能力。</p></div>
        <span>{builtinAssets.length} 个</span>
      </div>
      {builtinPriorityAssets.length > 0 && <div className="asset-card-grid priority builtin-priority">{builtinPriorityAssets.map(({ asset }) => <AssetCard key={asset.id} agent={agent} asset={asset}/>)}</div>}
      <div className="mt-2"><AssetGroup agent={agent} type="builtin" assets={builtinAssets}/></div>
    </section>}

    <div className="agent-detail-grid">
      <details className="agent-group">
        <summary><span>装配路径</span><span>{bindings.length}</span></summary>
        <div className="assembly-list">
          {installation?.executable && <div><span>Executable</span><code>{installation.executable}</code></div>}
          {installation?.configRoot && <div><span>Config</span><code>{installation.configRoot}</code></div>}
          {installation?.dataRoot && <div><span>Data</span><code>{installation.dataRoot}</code></div>}
          {visibleBindings.map(({ asset, binding }) => binding.path ? <div key={binding.id}><span>{assetTypeLabel[asset.type] ?? asset.type}</span><code>{binding.path}</code></div> : null)}
          {!installation && !bindings.some(item => item.binding.path) && <div className="overview-empty-line">暂无装配路径</div>}
        </div>
        {bindings.length > ASSEMBLY_PATH_LIMIT && <button className="agent-group-more" onClick={() => setShowAllBindings(value => !value)}>{showAllBindings ? '收起' : `查看更多 ${bindings.length - ASSEMBLY_PATH_LIMIT} 条路径`}</button>}
      </details>

      <details className="agent-group">
        <summary><span>可观测能力</span><span>{agent.capabilities.length}</span></summary>
        <div className="capability-grid">
          {agent.capabilities.map(cap => <div key={cap.name} className="capability-item" title={cap.reason}>
            <span>{capabilityLabel[cap.name] ?? cap.name}</span>
            <b data-status={cap.status}>{cap.status}</b>
          </div>)}
        </div>
      </details>
    </div>
  </article>
}

export function AgentsPage({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const agents = snapshot.facets?.agents ?? []
  const items = snapshot.agents?.items ?? []
  const [sourceId, setSourceId] = useState('')
  const shown = sourceId ? items.filter(item => item.sourceId === sourceId) : items

  return <main className="mx-auto max-w-[1800px]">
    <div className="toolbar">
      <AgentScope agents={agents} value={sourceId} onChange={setSourceId}/>
      <button className="icon-button ml-auto" onClick={() => void model.refreshFacetsAndAgents()} title="刷新 Agent 概览">↻</button>
    </div>

    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Agent 概览</h1>
        <p className="mt-1 text-sm text-muted">先看自己的 AI 资产和实际使用，再按需查看 Agent 内建能力、装配路径与观测边界。</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">{shown.map(agent => <AgentCard key={agent.sourceId} agent={agent}/>)}</div>
      {!shown.length && <div className="empty py-24">没有可显示的 Agent</div>}
    </div>
  </main>
}