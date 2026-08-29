import { useMemo } from 'react'
import type { AgentAssetInventoryDto, AgentOverviewDto } from '@agent-lens/protocol'
import type { ClientSnapshot } from '../client/model'
import { agentLabel, sourceDot } from './AgentScope'

type JsonRecord = Record<string, unknown>
type CoverageStatus = 'used' | 'discoverable' | 'configured' | 'discovered' | 'unobserved'

function recordValue(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function arrayValue(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(recordValue).filter((item): item is JsonRecord => Boolean(item)) : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function formatBytes(value: number): string {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const scaled = value / (1024 ** index)
  return `${scaled >= 100 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`
}

function formatTime(value: string): string {
  if (!value) return '暂无'
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function stateValue(asset: AgentAssetInventoryDto, state: string): boolean | 'unknown' | undefined {
  let result: boolean | 'unknown' | undefined
  for (const binding of asset.bindings) {
    for (const item of binding.states) {
      if (item.state !== state) continue
      if (item.value === true) return true
      if (result === undefined || (result === 'unknown' && item.value === false)) result = item.value
    }
  }
  return result
}

function coverageStatus(agent: AgentOverviewDto, type: 'skill' | 'mcp', canonicalName: string): CoverageStatus {
  if (agent.usedAssets.some(item => item.type === type && item.canonicalName === canonicalName && item.callCount > 0)) return 'used'
  const asset = agent.assetInventory.find(item => item.type === type && item.canonicalName === canonicalName)
  if (!asset) return 'unobserved'
  if (stateValue(asset, 'discoverable') === true) return 'discoverable'
  if (['installed', 'configured', 'enabled', 'exposed'].some(state => stateValue(asset, state) === true)) return 'configured'
  return 'discovered'
}

const coverageStatusLabel: Record<CoverageStatus, string> = {
  used: '已使用',
  discoverable: '可发现',
  configured: '已配置',
  discovered: '已发现',
  unobserved: '未观察到',
}

const stageLabel: Record<string, string> = {
  history: '历史采集',
  runtime: '实时采集',
  assets: '资产扫描',
}

function CoverageCard({ agents }: { agents: AgentOverviewDto[] }) {
  const rows = useMemo(() => {
    const map = new Map<string, { type: 'skill' | 'mcp'; canonicalName: string; displayName: string; calls: number }>()
    for (const agent of agents) {
      for (const used of agent.usedAssets) {
        if (used.type !== 'skill' && used.type !== 'mcp') continue
        const key = `${used.type}:${used.canonicalName}`
        const asset = agent.assetInventory.find(item => item.type === used.type && item.canonicalName === used.canonicalName)
        const current = map.get(key) ?? {
          type: used.type,
          canonicalName: used.canonicalName,
          displayName: asset?.displayName ?? used.canonicalName,
          calls: 0,
        }
        current.calls += used.callCount
        map.set(key, current)
      }
    }
    return [...map.values()].sort((a, b) => b.calls - a.calls || a.displayName.localeCompare(b.displayName)).slice(0, 6)
  }, [agents])

  return <section className="agent-insight-card agent-coverage-card">
    <header className="agent-insight-head">
      <div><h2>高频资产覆盖</h2><p>真实用过的技能和 MCP 在各智能体中的可见状态。</p></div>
      <span>{rows.length ? `Top ${rows.length}` : '暂无记录'}</span>
    </header>
    <div className="agent-insight-body">
      {rows.length ? <div className="agent-coverage-list">
        {rows.map(row => <div className="agent-coverage-row" key={`${row.type}:${row.canonicalName}`}>
          <div className="agent-coverage-title"><b title={row.displayName}>{row.displayName}</b><small>{row.type === 'mcp' ? 'MCP' : '技能'} · {row.calls} 次真实调用</small></div>
          <div className="agent-coverage-agents">
            {agents.map(agent => {
              const status = coverageStatus(agent, row.type, row.canonicalName)
              return <span key={agent.sourceId} data-status={status} title={`${agentLabel(agent.sourceId, agent.displayName)}：${coverageStatusLabel[status]}`}>
                <i className={`source-dot ${sourceDot(agent.sourceId)}`}/><em>{coverageStatusLabel[status]}</em>
              </span>
            })}
          </div>
        </div>)}
      </div> : <div className="agent-insight-empty">暂无能够可靠归因的跨智能体技能或 MCP 使用记录。</div>}
    </div>
  </section>
}

export function AgentInsightsRail({ snapshot, sourceId }: { snapshot: ClientSnapshot; sourceId: string }) {
  const agents = snapshot.agents?.items ?? []
  const fallbackSourceId = agents.find(agent => agent.detected)?.sourceId || agents[0]?.sourceId || ''
  const selectedSourceId = agents.some(agent => agent.sourceId === sourceId) ? sourceId : fallbackSourceId
  const selectedAgent = agents.find(agent => agent.sourceId === selectedSourceId)

  const details = recordValue(snapshot.health?.storage.details)
  const growth = recordValue(details?.dataGrowth)
  const checkpoints = recordValue(details?.checkpoints)
  const sourceRuntime = recordValue(details?.sourceRuntime)
  const unknownRoot = recordValue(details?.unknownObservations)
  const runtime = arrayValue(sourceRuntime?.items).filter(item => stringValue(item.sourceId) === selectedSourceId)
  const unknown = arrayValue(unknownRoot?.groups).filter(item => stringValue(item.sourceId) === selectedSourceId)
  const failedStages = runtime.filter(item => stringValue(item.state) === 'failed').length
  const unknownCount = unknown.reduce((sum, item) => sum + numberValue(item.count), 0)
  const hasIssue = failedStages > 0 || unknownCount > 0

  if (!selectedAgent) return null

  return <aside className="agent-insights-rail" aria-label="智能体洞察">
    <section className="agent-insight-card agent-diagnostics-card">
      <header className="agent-insight-head">
        <div><h2>采集诊断</h2><p>{agentLabel(selectedAgent.sourceId, selectedAgent.displayName)} · 采集链路与本地数据状态。</p></div>
        <span data-state={hasIssue ? 'warn' : 'ok'}>{hasIssue ? `${failedStages} 异常 · ${unknownCount.toLocaleString()} 待适配` : '运行正常'}</span>
      </header>
      <div className="agent-insight-body">
        <div className="agent-diagnostic-summary-grid">
          <span><small>主数据库</small><b>{formatBytes(numberValue(growth?.databaseBytes))}</b></span>
          <span><small>WAL</small><b>{formatBytes(numberValue(growth?.walBytes))}</b></span>
          <span><small>检查点</small><b>{numberValue(checkpoints?.count).toLocaleString()}</b></span>
          <span><small>最近更新</small><b>{formatTime(stringValue(checkpoints?.lastUpdatedAt))}</b></span>
        </div>
        {runtime.length > 0 && <div className="agent-diagnostic-stage-list">
          {runtime.map((item, index) => <span key={`${stringValue(item.stage)}-${stringValue(item.runtimeProfileId)}-${index}`} data-state={stringValue(item.state)} title={stringValue(item.lastErrorSummary)}>
            {stageLabel[stringValue(item.stage)] ?? stringValue(item.stage) || '采集阶段'} · {stringValue(item.state) === 'healthy' ? '正常' : stringValue(item.state) === 'failed' ? '异常' : '运行中'}
          </span>)}
        </div>}
        {unknownCount > 0 && <div className="agent-diagnostic-unknown"><b>尚未适配的原生事件</b><span>{unknown.slice(0, 3).map(item => `${stringValue(item.nativeType) || '未知类型'} × ${numberValue(item.count).toLocaleString()}`).join(' · ')}</span>{unknown.length > 3 && <small>另有 {unknown.length - 3} 类原生事件</small>}</div>}
        {!runtime.length && !growth && <div className="agent-insight-empty">当前健康信息尚未提供采集诊断明细。</div>}
      </div>
    </section>
    <CoverageCard agents={agents}/>
  </aside>
}
