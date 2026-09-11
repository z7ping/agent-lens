import { useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
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

const capabilityLabelKey: Record<string, string> = {
  session: 'capability.session',
  transcript: 'capability.transcript',
  'tool-call': 'capability.toolCall',
  'tool-result': 'capability.toolResult',
  permission: 'capability.permission',
  subagent: 'capability.subagent',
  context: 'capability.context',
  thinking: 'capability.thinking',
  'asset-discovery': 'capability.assetDiscovery',
  'asset-invocation': 'capability.assetInvocation',
  'artifact-action': 'capability.artifactAction',
  usage: 'capability.usage',
}

const capabilityStatusLabelKey: Record<string, string> = {
  available: 'capabilityStatus.available',
  partial: 'capabilityStatus.partial',
  experimental: 'capabilityStatus.experimental',
  unavailable: 'capabilityStatus.unavailable',
  'not-applicable': 'capabilityStatus.notApplicable',
}

const captureModeLabelKey: Record<string, string> = {
  history: 'captureMode.history',
  'runtime-hook': 'captureMode.runtimeHook',
  'native-tail': 'captureMode.nativeTail',
  'static-scan': 'captureMode.staticScan',
}

const stateLabelKey: Record<string, string> = {
  installed: 'state.installed',
  configured: 'state.configured',
  enabled: 'state.enabled',
  discoverable: 'state.discoverable',
  exposed: 'state.exposed',
  invoked: 'state.invoked',
  observed: 'state.observed',
}

const negativeStateLabelKey: Record<string, string> = {
  installed: 'negativeState.installed',
  configured: 'negativeState.configured',
  enabled: 'negativeState.enabled',
  discoverable: 'negativeState.discoverable',
  exposed: 'negativeState.exposed',
  invoked: 'negativeState.invoked',
  observed: 'negativeState.observed',
}

const assetTypeLabelKey: Record<string, string> = {
  skill: 'assetType.skill',
  mcp: 'assetType.mcp',
  plugin: 'assetType.plugin',
  extension: 'assetType.extension',
  hook: 'assetType.hook',
  memory: 'assetType.memory',
  prompt: 'assetType.prompt',
  theme: 'assetType.theme',
  context: 'assetType.context',
  rule: 'assetType.rule',
  builtin: 'assetType.builtin',
  unknown: 'assetType.unknown',
}

const assetTypeOrder = ['skill', 'mcp', 'plugin', 'extension', 'prompt', 'context', 'theme', 'hook', 'memory', 'rule', 'builtin', 'unknown']
const USER_ASSET_LIMIT = 24
const ASSEMBLY_PATH_LIMIT = 18

const integrationCapabilityLabelKey: Record<string, string> = {
  source: 'integrationCapability.source',
  hook: 'integrationCapability.hook',
  runtime: 'integrationCapability.runtime',
  live: 'integrationCapability.live',
}

const integrationAvailabilityLabelKey: Record<string, string> = {
  available: 'availability.available',
  partial: 'availability.partial',
  unavailable: 'availability.unavailable',
  error: 'availability.error',
}

const agentDescriptionKey: Record<string, string> = {
  codex: 'description.codex',
  'claude-code': 'description.claudeCode',
  pi: 'description.pi',
  hermes: 'description.hermes',
  opencode: 'description.opencode',
}

const integrationReasonKey: Record<string, string> = {
  'authorization-required': 'integration.reason.authorizationRequired',
  'authorization-restart-required': 'integration.reason.authorizationRestartRequired',
  'component-start-failed': 'integration.reason.componentStartFailed',
  'dependency-start-failed': 'integration.reason.dependencyStartFailed',
  'live-adapter-missing': 'integration.reason.liveAdapterMissing',
  'live-availability-failed': 'integration.reason.liveAvailabilityFailed',
}

function translatedLabel(
  map: Record<string, string>,
  value: string,
  t: TFunction,
): string {
  const key = map[value]
  return key ? t(key) : value
}

function integrationAvailabilityTone(
  availability: string,
): 'success' | 'warning' | 'danger' | 'neutral' {
  if (availability === 'available') return 'success'
  if (availability === 'partial' || availability === 'unavailable') return 'warning'
  if (availability === 'error') return 'danger'
  return 'neutral'
}

function captureState(
  agent: Pick<AgentOverviewDto, 'supported' | 'enabled' | 'detected'>,
  t: TFunction,
): { label: string; title: string; className: string } {
  if (!agent.supported) return { label: t('status.unsupported'), title: t('status.unsupportedTitle'), className: 'is-unsupported' }
  if (!agent.detected) return {
    label: agent.enabled ? t('status.notDetectedEnabled') : t('status.notDetectedDisabled'),
    title: agent.enabled ? t('status.notDetectedEnabledTitle') : t('status.notDetectedDisabledTitle'),
    className: agent.enabled ? 'is-enabled' : 'is-disabled',
  }
  if (!agent.enabled) return { label: t('status.detectedDisabled'), title: t('status.detectedDisabledTitle'), className: 'is-disabled' }
  return { label: t('status.detectedEnabled'), title: t('status.detectedEnabledTitle'), className: 'is-enabled is-detected' }
}

function capabilityDetail(
  cap: AgentOverviewDto['capabilities'][number],
  t: TFunction,
): string {
  const modes = cap.captureModes.map(mode => translatedLabel(captureModeLabelKey, mode, t))
  const parts = [modes.length
    ? t('captureMode.label', { modes: modes.join(' / ') })
    : t('captureMode.undeclared')]
  if (cap.reason) parts.push(t('captureMode.reason', { reason: cap.reason }))
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
  const { t } = useTranslation('agents')
  const positive = translatedLabel(stateLabelKey, state, t)
  const label = value === 'unknown'
    ? `${positive}${t('state.unknownSuffix')}`
    : value
      ? positive
      : negativeStateLabelKey[state]
        ? t(negativeStateLabelKey[state]!)
        : `${t('state.negativePrefix')}${positive}`
  return <span className="asset-state" data-value={String(value)}>{label}</span>
}

function CopyPath({ path }: { path: string }) {
  const { t } = useTranslation('agents')
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
  return <button className="copy-link" onClick={() => void copy()}>{copied ? t('copied') : t('copy')}</button>
}

function AssetCard({ agent, asset }: { agent: AgentOverviewDto; asset: AgentAssetInventoryDto }) {
  const { t } = useTranslation('agents')
  const usage = assetUsageCount(agent, asset)
  const path = asset.bindings.find(item => item.path)?.path
  const states = summarizedStates(asset)
  return <div className="asset-item">
    <div className="asset-item-head">
      <span className="asset-type">{translatedLabel(assetTypeLabelKey, asset.type, t)}</span>
      {usage > 0 && <span className="asset-usage">{t('realCalls', { count: usage })}</span>}
    </div>
    <div className="asset-name" title={asset.displayName ?? asset.canonicalName}>{asset.displayName ?? asset.canonicalName}</div>
    <div className="asset-states">
      {states.length ? <>{states.slice(0, 3).map(item => <StateBadge key={item.state} state={item.state} value={item.value}/>)}{states.length > 3 && <span className="asset-more-state">+{states.length - 3}</span>}</> : <span className="asset-discovered">{t('discovered')}</span>}
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
          >{integrationCapabilityLabel[item.capability] ?? item.capability} · {item.reason === '授权已保存，等待重启加载'
              ? '待重启'
              : item.authorization === 'required'
                ? '待授权'
                : integrationAvailabilityLabel[item.availability] ?? item.availability}</StatusBadge>)}
        </span>
      </div>}
      {configured && pendingAuthorization.length > 0 && !authorizationSaved && <div className="integration-authorization-action">
        <Button size="small" disabled={saving} onClick={() => setAuthorizationOpen(true)}>授权控制能力</Button>
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
        <Button variant="primary" loading={saving} onClick={() => void authorize()}>{configured ? '确认授权' : '确认授权并启用'}</Button>
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