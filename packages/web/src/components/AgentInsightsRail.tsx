import { useMemo } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { AgentAssetInventoryDto, AgentOverviewDto } from '@agent-lens/protocol'
import type { ClientSnapshot } from '../client/model'
import { agentLabel, sourceDot, useOrderedAgents } from './AgentScope'

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

function formatTime(value: string, locale: string, t: TFunction): string {
  if (!value) return t('insightsRail.unavailable')
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
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

const coverageStatusKey: Record<CoverageStatus, string> = {
  used: 'insightsRail.coverageStatus.used',
  discoverable: 'insightsRail.coverageStatus.discoverable',
  configured: 'insightsRail.coverageStatus.configured',
  discovered: 'insightsRail.coverageStatus.discovered',
  unobserved: 'insightsRail.coverageStatus.unobserved',
}

const stageKey: Record<string, string> = {
  history: 'insightsRail.stage.history',
  runtime: 'insightsRail.stage.runtime',
  assets: 'insightsRail.stage.assets',
}

function CoverageCard({ agents }: { agents: AgentOverviewDto[] }) {
  const { t } = useTranslation('agents')
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
      <div><h2>{t('insightsRail.coverageTitle')}</h2><p>{t('insightsRail.coverageDescription')}</p></div>
      <span>{rows.length ? `Top ${rows.length}` : t('insightsRail.noRecords')}</span>
    </header>
    <div className="agent-insight-body">
      {rows.length ? <div className="agent-coverage-list">
        {rows.map(row => <div className="agent-coverage-row" key={`${row.type}:${row.canonicalName}`}>
          <div className="agent-coverage-title"><b title={row.displayName}>{row.displayName}</b><small>{row.type === 'mcp' ? 'MCP' : t('insightsRail.skill')} · {t('insightsRail.realCalls', { count: row.calls })}</small></div>
          <div className="agent-coverage-agents">
            {agents.map(agent => {
              const status = coverageStatus(agent, row.type, row.canonicalName)
              return <span key={agent.sourceId} data-status={status} title={`${agentLabel(agent.sourceId, agent.displayName)}：${t(coverageStatusKey[status])}`}>
                <i className={`source-dot ${sourceDot(agent.sourceId)}`}/><em>{t(coverageStatusKey[status])}</em>
              </span>
            })}
          </div>
        </div>)}
      </div> : <div className="agent-insight-empty">{t('insightsRail.noCoverage')}</div>}
    </div>
  </section>
}

function NativeEventSummary({ groups, total }: { groups: JsonRecord[]; total: number }) {
  const { t, i18n } = useTranslation('agents')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const top = groups.slice(0, 3)
  const rest = groups.slice(3)
  const rows = (items: JsonRecord[]) => <div className="agent-coverage-list">
    {items.map((item, index) => {
      const nativeType = stringValue(item.nativeType) || t('insightsRail.unknownType')
      const count = numberValue(item.count)
      return <div className="agent-coverage-row" key={`${nativeType}-${index}`}>
        <div className="agent-coverage-title"><b title={nativeType}>{nativeType}</b><small>{t('insightsRail.records', { count: count.toLocaleString(locale) })}</small></div>
      </div>
    })}
  </div>

  return <div className="agent-diagnostic-unknown">
    <b>{t('insightsRail.nativeUnknownTitle')}</b>
    <span>{t('insightsRail.nativeUnknownSummary', { types: groups.length.toLocaleString(locale), total: total.toLocaleString(locale) })}</span>
    {rows(top)}
    {rest.length > 0 && <details className="disclosure-group">
      <summary><span>{t('insightsRail.showRemaining', { count: rest.length })}</span><span className="disclosure-count">{rest.length}</span></summary>
      {rows(rest)}
    </details>}
  </div>
}

export function AgentInsightsRail({ snapshot, sourceId }: { snapshot: ClientSnapshot; sourceId: string }) {
  const { t, i18n } = useTranslation('agents')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const agents = useOrderedAgents(snapshot.agents?.items ?? [])
  const fallbackSourceId = agents.find(agent => agent.detected)?.sourceId || agents[0]?.sourceId || ''
  const selectedSourceId = agents.some(agent => agent.sourceId === sourceId) ? sourceId : fallbackSourceId
  const selectedAgent = agents.find(agent => agent.sourceId === selectedSourceId)

  const details = recordValue(snapshot.health?.storage.details)
  const growth = recordValue(details?.dataGrowth)
  const capacity = recordValue(growth?.capacity)
  const checkpoints = recordValue(details?.checkpoints)
  const sourceRuntime = recordValue(details?.sourceRuntime)
  const unknownRoot = recordValue(details?.unknownObservations)
  const runtime = arrayValue(sourceRuntime?.items).filter(item => stringValue(item.sourceId) === selectedSourceId)
  const unknown = arrayValue(unknownRoot?.groups)
    .filter(item => stringValue(item.sourceId) === selectedSourceId)
    .sort((a, b) => numberValue(b.count) - numberValue(a.count) || stringValue(a.nativeType).localeCompare(stringValue(b.nativeType)))
  const failedStages = runtime.filter(item => stringValue(item.state) === 'failed').length
  const unknownCount = unknown.reduce((sum, item) => sum + numberValue(item.count), 0)
  const capacityState = stringValue(capacity?.state)
  const hasIssue = failedStages > 0 || unknownCount > 0 || capacityState === 'approaching' || capacityState === 'exceeded'

  if (!selectedAgent) return null

  return <aside className="agent-insights-rail" aria-label={t('insightsRail.aria')}>
    <section className="agent-insight-card agent-diagnostics-card">
      <header className="agent-insight-head">
        <div><h2>{t('insightsRail.diagnosticsTitle')}</h2><p>{t('insightsRail.diagnosticsDescription', { agent: agentLabel(selectedAgent.sourceId, selectedAgent.displayName) })}</p></div>
        <span data-state={hasIssue ? 'warn' : 'ok'}>{hasIssue ? t('insightsRail.issueSummary', { failed: failedStages, unknown: unknownCount.toLocaleString(locale) }) : t('insightsRail.healthy')}</span>
      </header>
      <div className="agent-insight-body">
        <div className="agent-diagnostic-summary-grid">
          <span><small>{t('insightsRail.database')}</small><b>{formatBytes(numberValue(growth?.databaseBytes))}</b></span>
          <span><small>WAL</small><b>{formatBytes(numberValue(growth?.walBytes))}</b></span>
          <span><small>{t('insightsRail.footprint')}</small><b>{formatBytes(numberValue(capacity?.footprintBytes))}</b></span>
          <span><small>{t('insightsRail.softLimit')}</small><b>{capacityState === 'exceeded' ? t('insightsRail.exceeded') : capacityState === 'approaching' ? t('insightsRail.approaching') : formatBytes(numberValue(capacity?.softLimitBytes))}</b></span>
          <span><small>{t('insightsRail.reclaimable')}</small><b>{formatBytes(numberValue(growth?.reclaimableBytes))}</b></span>
          <span><small>{t('insightsRail.checkpoints')}</small><b>{numberValue(checkpoints?.count).toLocaleString()}</b></span>
          <span><small>{t('insightsRail.lastUpdated')}</small><b>{formatTime(stringValue(checkpoints?.lastUpdatedAt), locale, t)}</b></span>
        </div>
        {runtime.length > 0 && <div className="agent-diagnostic-stage-list">
          {runtime.map((item, index) => {
            const stage = stringValue(item.stage)
            return <span key={`${stage}-${stringValue(item.runtimeProfileId)}-${index}`} data-state={stringValue(item.state)} title={stringValue(item.lastErrorSummary)}>
              {(stageKey[stage] ? t(stageKey[stage]) : stage) || t('insightsRail.stage.fallback')} · {stringValue(item.state) === 'healthy' ? t('insightsRail.stateHealthy') : stringValue(item.state) === 'failed' ? t('insightsRail.stateFailed') : t('insightsRail.stateRunning')}
            </span>
          })}
        </div>}
        {unknownCount > 0 && <NativeEventSummary groups={unknown} total={unknownCount}/>} 
        {!runtime.length && !growth && <div className="agent-insight-empty">{t('insightsRail.noDiagnostics')}</div>}
      </div>
    </section>
    <CoverageCard agents={agents}/>
  </aside>
}
