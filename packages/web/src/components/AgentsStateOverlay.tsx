import { useState } from 'react'
import type { AgentOverviewDto } from '@agent-lens/protocol'
import type { AgentLensClientModel, ClientSnapshot } from '../client/model'
import { agentLabel } from './AgentScope'
import { CommandRow, EmptyStatePanel, ErrorStateBanner, WorkspaceSkeleton } from './StateViews'

type JsonRecord = Record<string, unknown>

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

const stageLabel: Record<string, string> = {
  history: '历史采集',
  runtime: '实时采集',
  assets: '资产扫描',
}

interface AgentDiagnostics {
  runtime: JsonRecord[]
  coverage: JsonRecord[]
  unknown: JsonRecord[]
  failedStages: number
  healthyStages: number
  unknownCount: number
  unavailableCapabilities: number
}

function diagnosticsFor(agent: AgentOverviewDto, snapshot: ClientSnapshot): AgentDiagnostics {
  const details = recordValue(snapshot.health?.storage.details)
  const sourceRuntime = recordValue(details?.sourceRuntime)
  const coverageRoot = recordValue(details?.coverage)
  const unknownRoot = recordValue(details?.unknownObservations)
  const runtime = arrayValue(sourceRuntime?.items).filter(item => stringValue(item.sourceId) === agent.sourceId)
  const unknown = arrayValue(unknownRoot?.groups).filter(item => stringValue(item.sourceId) === agent.sourceId)
  const installationIds = new Set(agent.installations.map(item => item.id))
  const profileIds = new Set(runtime.map(item => stringValue(item.runtimeProfileId)).filter(Boolean))
  const coverage = arrayValue(coverageRoot?.items).filter(item => {
    const subjectId = stringValue(item.subjectId)
    return installationIds.has(subjectId) || profileIds.has(subjectId)
  })
  return {
    runtime,
    coverage,
    unknown,
    failedStages: runtime.filter(item => stringValue(item.state) === 'failed').length,
    healthyStages: runtime.filter(item => stringValue(item.state) === 'healthy').length,
    unknownCount: unknown.reduce((sum, item) => sum + numberValue(item.count), 0),
    unavailableCapabilities: agent.capabilities.filter(item => item.status === 'unavailable' || item.status === 'not-applicable').length,
  }
}

function coverageStatus(agent: AgentOverviewDto, diagnostics: AgentDiagnostics, capability: AgentOverviewDto['capabilities'][number]): { label: string; state: string; title: string } {
  if (!agent.supported) return { label: 'AgentLens 尚未支持', state: 'unsupported', title: '当前版本尚未声明支持该来源。' }
  if (capability.status === 'unavailable') return { label: '来源不提供', state: 'unavailable', title: capability.reason ?? '该来源没有提供这项可观察能力。' }
  if (capability.status === 'not-applicable') return { label: '不适用', state: 'muted', title: capability.reason ?? '该能力不适用于此来源。' }
  const rows = diagnostics.coverage.filter(item => stringValue(item.capability) === capability.name)
  if (rows.some(item => stringValue(item.status) === 'complete')) return { label: '已覆盖', state: 'complete', title: '当前已有完整覆盖范围证据。' }
  if (rows.some(item => stringValue(item.status) === 'partial')) return { label: '部分覆盖', state: 'partial', title: '当前只有部分时间或部分采集路径有可靠数据。' }
  if (rows.some(item => stringValue(item.status) === 'unavailable')) return { label: '来源不提供', state: 'unavailable', title: '覆盖记录明确表明来源无法提供这项数据。' }
  if (rows.some(item => stringValue(item.status) === 'unknown')) return { label: '尚未确认', state: 'unknown', title: 'AgentLens 当前无法确认这项数据是否完整。' }
  if (agent.detected && agent.enabled && diagnostics.healthyStages > 0 && diagnostics.failedStages === 0) {
    return { label: '当前没有发生', state: 'empty', title: '采集链路正常，但当前没有形成这项能力的覆盖记录。' }
  }
  return { label: '尚未确认', state: 'unknown', title: '当前缺少足够的运行或覆盖证据，不能判断为 0。' }
}

function DiagnosticAgent({ agent, diagnostics }: { agent: AgentOverviewDto; diagnostics: AgentDiagnostics }) {
  const hasUnknown = diagnostics.unknownCount > 0
  const hasFailure = diagnostics.failedStages > 0
  return <section className="agent-diagnostic-source" data-state={hasFailure ? 'failed' : hasUnknown ? 'unknown' : 'ok'}>
    <div className="agent-diagnostic-source-head">
      <div><b>{agentLabel(agent.sourceId, agent.displayName)}</b><small>{agent.detected ? '已检测' : '未检测'} · {agent.enabled ? '采集已启用' : '采集未启用'}</small></div>
      <span>{hasFailure ? `${diagnostics.failedStages} 个阶段异常` : hasUnknown ? `${diagnostics.unknownCount} 条待适配` : '未发现异常'}</span>
    </div>
    {diagnostics.runtime.length > 0 && <div className="agent-diagnostic-runtime">
      {diagnostics.runtime.map((item, index) => <span key={`${stringValue(item.stage)}-${stringValue(item.runtimeProfileId)}-${index}`} data-state={stringValue(item.state)} title={stringValue(item.lastErrorSummary)}>
        {stageLabel[stringValue(item.stage)] ?? stringValue(item.stage)} · {stringValue(item.state) === 'healthy' ? '正常' : stringValue(item.state) === 'failed' ? '异常' : '运行中'}
      </span>)}
    </div>}
    {hasUnknown && <div className="agent-diagnostic-warning">
      <b>AgentLens 尚未支持</b>
      <span>{diagnostics.unknown.slice(0, 3).map(item => `${stringValue(item.nativeType) || '未知类型'} × ${numberValue(item.count)}`).join(' · ')}</span>
      {diagnostics.unknown.length > 3 && <small>另有 {diagnostics.unknown.length - 3} 类原生事件</small>}
    </div>}
    <div className="agent-diagnostic-capabilities">
      {agent.capabilities.map(capability => {
        const semantic = coverageStatus(agent, diagnostics, capability)
        return <div key={capability.name} className="agent-diagnostic-capability" title={semantic.title}>
          <span>{capabilityLabel[capability.name] ?? capability.name}</span>
          <b data-state={semantic.state}>{semantic.label}</b>
        </div>
      })}
      {!agent.capabilities.length && <div className="agent-diagnostic-empty">暂无能力声明，不能把未观察到解释为 0。</div>}
    </div>
  </section>
}

function AgentDiagnosticsPanel({ snapshot }: { snapshot: ClientSnapshot }) {
  const agents = snapshot.agents?.items.filter(agent => agent.detected || agent.enabled) ?? []
  const rows = agents.map(agent => ({ agent, diagnostics: diagnosticsFor(agent, snapshot) }))
  const failed = rows.reduce((sum, item) => sum + item.diagnostics.failedStages, 0)
  const unknown = rows.reduce((sum, item) => sum + item.diagnostics.unknownCount, 0)
  const hasIssue = failed > 0 || unknown > 0
  const [open, setOpen] = useState(hasIssue)
  if (!agents.length || !snapshot.health) return null
  return <details className="agent-diagnostics-dock" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span><b>采集诊断</b><small>区分没有发生、来源不提供与尚未适配</small></span>
      <span className="agent-diagnostics-summary" data-state={hasIssue ? 'warn' : 'ok'}>{hasIssue ? `${failed} 异常 · ${unknown} 待适配` : '运行正常'}</span>
    </summary>
    <div className="agent-diagnostics-body">
      <div className="agent-diagnostics-legend">
        <span data-state="complete">已覆盖</span>
        <span data-state="empty">当前没有发生</span>
        <span data-state="unavailable">来源不提供</span>
        <span data-state="unsupported">AgentLens 尚未支持</span>
      </div>
      {rows.map(item => <DiagnosticAgent key={item.agent.sourceId} agent={item.agent} diagnostics={item.diagnostics}/>)}
    </div>
  </details>
}

export function AgentsStateOverlay({ model, snapshot }: { model: AgentLensClientModel; snapshot: ClientSnapshot }) {
  const response = snapshot.agents
  const hasSseBanner = Boolean(snapshot.health && !snapshot.liveConnected)
  const shellClass = `agents-state-overlay ${hasSseBanner ? 'has-sse-banner' : ''}`

  if (!response && snapshot.facets) {
    return <div className={`${shellClass} is-empty`}>
      <div className="agents-state-inner">
        <ErrorStateBanner message="智能体概览暂时无法加载。后台服务仍可访问，可重试概览查询或运行诊断命令。" onRetry={() => void model.refreshFacetsAndAgents()}/>
      </div>
    </div>
  }

  if (!response) {
    return <div className={`${shellClass} is-loading`} aria-live="polite">
      <div className="agents-state-inner"><WorkspaceSkeleton kind="cards"/></div>
    </div>
  }

  if (!response.items.some(agent => agent.detected)) {
    return <div className={`${shellClass} is-empty`}>
      <div className="agents-state-inner">
        <EmptyStatePanel
          icon="◇"
          title="未检测到受支持的智能体"
          description="本机暂未检测到 Codex、Claude Code、Pi、Hermes、OpenCode 或 DSH。AgentLens 不会把“未观察到”直接判断成“未安装”，可先运行诊断命令确认各来源的检测路径与采集状态。"
        >
          <CommandRow command="agent-lens doctor"/>
        </EmptyStatePanel>
      </div>
    </div>
  }

  return <AgentDiagnosticsPanel snapshot={snapshot}/>
}
