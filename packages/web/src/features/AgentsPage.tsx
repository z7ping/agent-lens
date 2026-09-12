import { useMemo, useState, type DragEvent } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type {
  AgentAssetInventoryDto,
  AgentOverviewDto,
  CapturePolicyResponseDto,
  IntegrationAuthorizationCapabilityDto,
  IntegrationManagementItemDto,
  IntegrationPackageOperationResponseDto,
  IntegrationToolDiscoveryItemDto,
  ManagedAssetRoot,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { agentLabel, sourceDot, useOrderedAgents } from '../components/AgentScope'
import { useIntegrationOrder } from '../components/IntegrationOrderProvider'
import { CompactPageHeading } from '../components/CompactPageHeading'
import { AgentManagedFilesDrawer } from '../components/AgentManagedFilesDrawer'
import { Button, IconButton, StatusBadge, Toolbar, UiIcon } from '../components/ui'
import { copyText } from '../client/clipboard'
import {
  IntegrationAdvancedActions,
  IntegrationControl,
  IntegrationOnlyCard,
} from './integrations/IntegrationManagementControls'
import {
  integrationLifecycleState,
  integrationToolPresenceLabel,
  integrationToolPresencePath,
} from './integrations/integration-lifecycle'

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
  instruction: 'assetType.instruction',
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

const assetTypeOrder = ['instruction', 'skill', 'mcp', 'plugin', 'extension', 'prompt', 'theme', 'hook', 'memory', 'builtin', 'unknown']
function assetPresentationType(type: string): string {
  return type === 'context' || type === 'rule' ? 'instruction' : type
}

const assetScopeLabelKey: Record<string, string> = {
  installation: 'assetScope.installation',
  user: 'assetScope.user',
  project: 'assetScope.project',
  workspace: 'assetScope.workspace',
}
const USER_ASSET_LIMIT = 24
const RUNTIME_CONFIG_PATH_LIMIT = 18

const agentDescriptionKey: Record<string, string> = {
  codex: 'description.codex',
  'claude-code': 'description.claudeCode',
  pi: 'description.pi',
  hermes: 'description.hermes',
  opencode: 'description.opencode',
}

function translatedLabel(
  map: Record<string, string>,
  value: string,
  t: TFunction,
): string {
  const key = map[value]
  return key ? t(key) : value
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


function assetScopeLabels(
  asset: AgentAssetInventoryDto,
  t: TFunction,
): Array<{ key: string; label: string; title?: string }> {
  const values = new Map<string, { key: string; label: string; title?: string }>()
  for (const binding of asset.bindings) {
    if (!binding.scope) continue
    const root = binding.scopeRoot
    const key = `${binding.scope}\u0000${root ?? ''}`
    if (values.has(key)) continue
    const scopeLabel = translatedLabel(assetScopeLabelKey, binding.scope, t)
    values.set(key, {
      key,
      label: scopeLabel,
      ...(root ? { title: root } : {}),
    })
  }
  return [...values.values()]
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
  const scopes = assetScopeLabels(asset, t)
  const presentationType = assetPresentationType(asset.type)
  return <div className="asset-item">
    <div className="asset-item-head">
      <span className="asset-type">{translatedLabel(assetTypeLabelKey, presentationType, t)}</span>
      {scopes.slice(0, 2).map(scope => <span
        key={scope.key}
        className="asset-scope"
        title={scope.title}
      >{scope.label}</span>)}
      {scopes.length > 2 && <span className="asset-scope">+{scopes.length - 2}</span>}
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
  const { t } = useTranslation('agents')
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? assets : assets.slice(0, USER_ASSET_LIMIT)
  return <details className="disclosure-group">
    <summary><DisclosureChevron/><span>{translatedLabel(assetTypeLabelKey, type, t)}</span><span className="disclosure-count">{assets.length}</span></summary>
    <div className="asset-list-grid">{shown.map(asset => <AssetCard key={asset.id} agent={agent} asset={asset}/>)}</div>
    {assets.length > USER_ASSET_LIMIT && <button className="show-more-button" onClick={() => setShowAll(value => !value)}>{showAll ? t('collapse') : t('showMoreItems', { count: assets.length - USER_ASSET_LIMIT })}</button>}
  </details>
}

function FrequentAssets({ agent, assets }: { agent: AgentOverviewDto; assets: AgentAssetInventoryDto[] }) {
  const { t } = useTranslation('agents')
  if (!assets.length) return <div className="muted-empty compact">{t('noReliableSkillMcpUsage')}</div>
  const rows = assets.map(asset => ({ asset, count: assetUsageCount(agent, asset) }))
  const max = Math.max(1, ...rows.map(row => row.count))
  return <div className="frequent-assets">
    {rows.map(({ asset, count }, index) => <div key={asset.id} className="frequent-asset-row">
      <span className="frequent-rank">{index + 1}</span>
      <div className="frequent-main"><b>{asset.displayName ?? asset.canonicalName}</b><span>{translatedLabel(assetTypeLabelKey, asset.type, t)}</span></div>
      <span className="frequent-usage-track" aria-hidden="true"><i style={{ width: `${Math.max(4, count / max * 100)}%` }}/></span>
      <strong>{count}</strong>
    </div>)}
  </div>
}

function SkillLifecycle({ agent, skills }: { agent: AgentOverviewDto; skills: AgentAssetInventoryDto[] }) {
  const { t } = useTranslation('agents')
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
    { key: 'installed', label: installedReported ? t('lifecycle.installed') : t('lifecycle.discovered'), value: installed, percent: 100, active: false },
    { key: 'discoverable', label: discoverableKnown ? t('lifecycle.discoverable') : t('lifecycle.discoverableUnknown'), value: discoverable, percent: discoverable === null ? 0 : Math.min(100, discoverable / baseline * 100), active: false },
    { key: 'used', label: t('lifecycle.used'), value: used, percent: Math.min(100, used / baseline * 100), active: true },
  ]

  return <section className="skill-lifecycle">
    <div className="section-heading-row"><div><h3>{t('lifecycle.title')}</h3><p>{t('lifecycle.description')}</p></div></div>
    <div className="skill-funnel">
      {rows.map(row => <div key={row.key} className="skill-funnel-row" data-active={row.active || undefined} data-muted={row.value === null || undefined}>
        <span>{row.label}</span>
        <span className="skill-funnel-track" aria-hidden="true"><i style={{ width: `${Math.max(row.value === null ? 0 : 4, row.percent)}%` }}/></span>
        <strong>{row.value ?? '—'}</strong>
      </div>)}
    </div>
    {!discoverableKnown && <p className="skill-funnel-note">{t('lifecycle.unknownNote')}</p>}
  </section>
}

function AgentCard({ model, agent, management, discovery, discoveryScanning, discoveryError, policy, onCaptureChange, onInstall, onRemove, onAuthorize }: {
  model: AgentLensClientModel
  agent: AgentOverviewDto
  management: IntegrationManagementItemDto | undefined
  discovery: IntegrationToolDiscoveryItemDto | undefined
  discoveryScanning: boolean
  discoveryError: string
  policy: CapturePolicyResponseDto | null
  onCaptureChange(sourceId: string, enabled: boolean): Promise<void>
  onInstall(integrationId: string): Promise<IntegrationPackageOperationResponseDto>
  onRemove(integrationId: string): Promise<IntegrationPackageOperationResponseDto>
  onAuthorize(
    productId: string,
    capabilities: readonly IntegrationAuthorizationCapabilityDto[],
  ): Promise<unknown>
}) {
  const { t } = useTranslation('agents')
  const [showAllBindings, setShowAllBindings] = useState(false)
  const [managedRoot, setManagedRoot] = useState<ManagedAssetRoot | null>(null)
  const installation = agent.installations[0]
  const grouped = useMemo(() => {
    const map = new Map<string, AgentAssetInventoryDto[]>()
    for (const asset of agent.assetInventory) {
      const presentationType = assetPresentationType(asset.type)
      const list = map.get(presentationType) ?? []
      list.push(asset)
      map.set(presentationType, list)
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
  const visibleBindings = showAllBindings ? bindings : bindings.slice(0, RUNTIME_CONFIG_PATH_LIMIT)
  const userAssetCount = userGrouped.reduce((sum, [, assets]) => sum + assets.length, 0)
  const userUsageCount = agent.usedAssets.reduce((sum, item) => sum + item.callCount, 0)
  const status = integrationLifecycleState(agent, management, discovery, discoveryScanning, t)
  const presencePath = integrationToolPresencePath(discovery)
  const configPath = installation?.configRoot ?? discovery?.configRoot ?? discovery?.dataRoot
  const assetsAvailable = agent.integration?.capabilities.some(capability =>
    capability.capability === 'assets' && capability.availability === 'available'
  ) ?? false
  const managedRootPath = managedRoot === 'config'
    ? installation?.configRoot
    : managedRoot === 'data'
      ? installation?.dataRoot
      : undefined
  const runtimeConfigCount = bindings.length
    + (installation?.executable ? 1 : 0)
    + (installation?.configRoot ? 1 : 0)
    + (installation?.dataRoot ? 1 : 0)

  return <article className="agent-card" data-source={agent.sourceId} data-enabled={String(agent.enabled)}>
    <header className="agent-card-head">
      <div className="agent-identity">
        <span className={`source-dot large ${sourceDot(agent.sourceId)}`}/>
        <div><h2>{agentLabel(agent.sourceId, agent.displayName)}</h2><p>{agentDescriptionKey[agent.sourceId] ? t(agentDescriptionKey[agent.sourceId]!) : t('description.fallback')}</p></div>
      </div>
      <span className={`agent-status ${status.className}`} title={status.title}>{status.label}</span>
    </header>

    <div className="agent-installation">
      <span className="agent-tool-presence"><small>{t('toolPresence.label')}</small><b data-presence={discoveryError ? 'error' : discovery?.presence ?? (discoveryScanning ? 'scanning' : 'absent')}>{integrationToolPresenceLabel(discovery, discoveryScanning, discoveryError, t)}</b></span>
      <span><small>{t('installation.version')}</small><b>{installation?.version ?? (agent.detected ? t('installation.versionUnavailable') : t('installation.notDetected'))}</b></span>
      {management?.packageState && <span><small>{t('installation.integrationVersion')}</small><b>{management.packageState.installedVersion ?? management.packageState.availableVersion ?? t('installation.notAdded')}</b></span>}
      <span className="agent-config"><small>{t('installation.configDirectory')}</small><code title={configPath}>{configPath ? shortPath(configPath, 52) : agent.detected ? t('installation.pathUnavailable') : t('installation.notDetected')}</code></span>
      {presencePath && !configPath && <span className="agent-config"><small>{t('toolPresence.location')}</small><code title={presencePath}>{shortPath(presencePath, 52)}</code></span>}
    </div>
    {discovery?.presence === 'data-only' && <p className="agent-discovery-note">{t('toolPresence.dataOnlyHint')}</p>}
    {(discoveryError || discovery?.presence === 'error') && <p className="agent-discovery-note is-error" title={discoveryError || discovery?.reason}>{t('toolPresence.errorHint')}</p>}

    <IntegrationControl agent={agent} management={management} policy={policy} onChange={onCaptureChange} onInstall={onInstall} onAuthorize={onAuthorize}/>

    <section className="agent-primary-section">
      <div className="section-heading-row"><div><h3>{t('sections.myAssets')}</h3><p>{t('sections.myAssetsDescription')}</p></div><span className="section-total">{userAssetCount}</span></div>
      <div className="asset-kpis">
        {userGrouped.length ? userGrouped.map(([type, items]) => <div key={type} className="asset-kpi"><strong>{items.length}</strong><span>{translatedLabel(assetTypeLabelKey, type, t)}</span></div>) : <div className="muted-empty compact">{t('sections.noUserAssets')}</div>}
      </div>
      {userUsageCount > 0 && <div className="reliable-usage">{t('sections.reliableCalls', { count: userUsageCount })}</div>}
    </section>

    <section className="agent-primary-section">
      <div className="section-heading-row"><div><h3>{t('sections.recentUsed')}</h3><p>{t('sections.recentUsedDescription')}</p></div></div>
      <FrequentAssets agent={agent} assets={priorityAssets}/>
    </section>

    <SkillLifecycle agent={agent} skills={skillAssets}/>

    <section className="agent-disclosures">
      {userGrouped.map(([type, assets]) => <AssetGroup key={type} agent={agent} type={type} assets={assets}/>)}
      {agent.assetInventoryStatus === 'unavailable' && <div className="muted-empty compact">{t('sections.inventoryUnavailable')}</div>}
    </section>

    <section className="agent-secondary">
      {builtinAssets.length > 0 && <AssetGroup agent={agent} type="builtin" assets={builtinAssets}/>} 
      <details className="disclosure-group">
        <summary><DisclosureChevron/><span>{t('sections.runtimeConfig')}</span><span className="disclosure-count">{runtimeConfigCount}</span></summary>
        <div className="runtime-config-list">
          {installation?.executable && <div className="runtime-config-row"><span>{t('sections.executable')}</span><code>{installation.executable}</code><CopyPath path={installation.executable}/></div>}
          {installation?.configRoot && <div className="runtime-config-row">
            <span>{t('sections.config')}</span>
            <code>{installation.configRoot}</code>
            <CopyPath path={installation.configRoot}/>
            {assetsAvailable && <Button size="small" onClick={() => setManagedRoot('config')}>{t('sections.browse')}</Button>}
          </div>}
          {installation?.dataRoot && <div className="runtime-config-row">
            <span>{t('sections.data')}</span>
            <code>{installation.dataRoot}</code>
            <CopyPath path={installation.dataRoot}/>
            {assetsAvailable && <Button size="small" onClick={() => setManagedRoot('data')}>{t('sections.browse')}</Button>}
          </div>}
          {visibleBindings.map(({ asset, binding }) => binding.path ? <div className="runtime-config-row" key={binding.id}><span>{translatedLabel(assetTypeLabelKey, asset.type, t)}</span><code>{binding.path}</code></div> : null)}
          {!installation && !bindings.some(item => item.binding.path) && <div className="muted-empty compact">{t('sections.noRuntimeConfig')}</div>}
        </div>
        {bindings.length > RUNTIME_CONFIG_PATH_LIMIT && <button className="show-more-button" onClick={() => setShowAllBindings(value => !value)}>{showAllBindings ? t('collapse') : t('sections.showMorePaths', { count: bindings.length - RUNTIME_CONFIG_PATH_LIMIT })}</button>}
      </details>
      <details className="disclosure-group">
        <summary title={t('sections.captureSupportTitle')}><DisclosureChevron/><span>{t('sections.captureSupport')}</span><span className="disclosure-count">{agent.capabilities.length}</span></summary>
        <div className="capability-list">
          {agent.capabilities.map(cap => <div key={cap.name} className="capability-row" title={capabilityDetail(cap, t)}><span>{translatedLabel(capabilityLabelKey, cap.name, t)} · {capabilityDetail(cap, t)}</span><b data-status={cap.status}>{translatedLabel(capabilityStatusLabelKey, cap.status, t)}</b></div>)}
        </div>
      </details>
      <IntegrationAdvancedActions
        management={management}
        label={agentLabel(agent.sourceId, agent.displayName)}
        onChange={onCaptureChange}
        onRemove={onRemove}
      />
    </section>
    {managedRoot && installation && managedRootPath && <AgentManagedFilesDrawer
      open
      model={model}
      productId={agent.productId}
      agentName={agentLabel(agent.sourceId, agent.displayName)}
      installationId={installation.id}
      root={managedRoot}
      rootLabel={managedRoot === 'config' ? t('sections.configDirectory') : t('sections.dataDirectory')}
      rootPath={managedRootPath}
      onClose={() => setManagedRoot(null)}
    />}
  </article>
}

export function AgentsPage({ model, sourceId, onSourceIdChange }: { model: AgentLensClientModel; sourceId: string; onSourceIdChange(sourceId: string): void }) {
  const { t } = useTranslation('agents')
  const snapshot = useClientSnapshot(model)
  const overviewItems = useOrderedAgents(snapshot.agents?.items ?? [])
  const managementItems = snapshot.integrationManagement?.items ?? []
  const discovery = snapshot.integrationDiscovery
  const discoveryScanning = snapshot.integrationDiscoveryLoading
    || snapshot.integrationDiscoveryRescanning
    || discovery?.status === 'scanning'
  const { ordered, canReorder, move, moveBy, reset } = useIntegrationOrder()
  const [managingOrder, setManagingOrder] = useState(false)
  const [draggedId, setDraggedId] = useState('')

  const discoveryItems = discovery?.items ?? []
  const claimedSourceIds = new Set<string>()
  const managedRows = managementItems.map(management => {
    const agent = overviewItems.find(item =>
      item.productId === management.productId || item.sourceId === management.integrationId
    )
    if (agent) claimedSourceIds.add(agent.sourceId)
    const tool = management.tool ?? discoveryItems.find(item =>
      item.productId === management.productId || item.integrationId === management.integrationId
    )
    return {
      id: management.integrationId,
      displayName: management.displayName,
      agent,
      management,
      discovery: tool,
    }
  })
  const orderIndex = new Map(ordered.map((id, index) => [id, index]))
  managedRows.sort((left, right) =>
    (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || left.management.displayOrder - right.management.displayOrder
    || left.id.localeCompare(right.id)
  )
  const rows = [
    ...managedRows,
    ...overviewItems
      .filter(agent => !claimedSourceIds.has(agent.sourceId))
      .map(agent => ({
        id: agent.sourceId,
        displayName: agent.displayName,
        agent,
        management: undefined,
        discovery: discoveryItems.find(item =>
          item.productId === agent.productId || item.integrationId === agent.sourceId
        ),
      })),
  ]

  const fallbackRow = rows.find(row =>
    row.agent?.detected
    || row.discovery?.presence === 'present'
    || row.discovery?.presence === 'data-only'
  ) ?? rows[0]
  const selectedSourceId = rows.some(row => row.id === sourceId) ? sourceId : fallbackRow?.id ?? ''
  const selectedRow = rows.find(row => row.id === selectedSourceId)
  const selectedAgent = selectedRow?.agent
  const selectedManagement = selectedRow?.management
  const selectedDiscovery = selectedRow?.discovery
  const discoveryErrors = discovery?.items.filter(item => item.presence === 'error') ?? []
  const rescan = snapshot.agentsRescanResult
  const rescanning = snapshot.agentsRescanning || snapshot.integrationDiscoveryRescanning
  const scanBusy = rescanning || discoveryScanning
  const rescanStatus = scanBusy
    ? <StatusBadge tone="accent" dot>{t('page.rescanning')}</StatusBadge>
    : snapshot.integrationDiscoveryError
      ? <StatusBadge tone="danger" title={snapshot.integrationDiscoveryError}>{t('page.toolScanFailed')}</StatusBadge>
      : snapshot.agentsRescanError
        ? <StatusBadge tone="danger" title={snapshot.agentsRescanError}>{t('page.rescanFailed')}</StatusBadge>
        : discoveryErrors.length
          ? <StatusBadge tone="warning" title={discoveryErrors.map(item => `${item.displayName}: ${item.reason ?? t('toolPresence.error')}`).join('\n')}>{t('page.toolScanPartial', { count: discoveryErrors.length })}</StatusBadge>
          : rescan
            ? <StatusBadge tone={rescan.status === 'completed' ? 'success' : 'danger'} title={rescan.failures.map(item => `${item.sourceId}: ${item.message}`).join('\n') || undefined}>
                {rescan.status === 'completed'
                  ? `${t('page.scanCompleted', { sources: rescan.sourcesDetected, assets: rescan.assetsDiscovered })}${rescan.assetsRemoved ? t('page.removedSuffix', { count: rescan.assetsRemoved }) : ''}`
                  : rescan.status === 'partial'
                    ? t('page.scanPartial', { count: rescan.failures.length })
                    : t('page.scanFailedSummary', { count: rescan.failures.length })}
              </StatusBadge>
            : null

  const installIntegration = async (integrationId: string) => {
    const result = await model.installIntegration(integrationId)
    if (result.operation.status === 'completed' && result.state.installed) {
      await model.acknowledgeIntegration(integrationId).catch(() => undefined)
    }
    return result
  }

  const selectRow = (integrationId: string, isNew: boolean | undefined) => {
    onSourceIdChange(integrationId)
    if (isNew) void model.acknowledgeIntegration(integrationId).catch(() => undefined)
  }

  const reorderableRows = rows.filter(row => canReorder(row.id))

  return <main className="workspace-page">
    <div className="page-content agents-content">
      <CompactPageHeading title={t('page.title')} description={t('page.description')}>
        <Toolbar aria-label={t('page.scanToolbar')} className="agents-rescan-toolbar">
          <Button size="small" loading={scanBusy} disabled={scanBusy} onClick={() => void model.rescanAgentEnvironment().catch(() => undefined)}><UiIcon name="refresh" size={14}/>{scanBusy ? t('page.scanning') : t('page.rescan')}</Button>
          {rescanStatus}
        </Toolbar>
      </CompactPageHeading>
      {rows.length ? <div className="agents-browser">
        <nav className="agent-source-nav" aria-label={t('page.list')}>
          <div className="agent-source-nav-head"><b>{managingOrder ? t('page.orderTitle') : t('page.localAgents')}</b><span>{rows.length}</span></div>
          <div className="agent-source-nav-actions">
            {managingOrder ? <>
              <Button size="small" onClick={reset}>{t('scope.reset')}</Button>
              <Button size="small" variant="primary" onClick={() => { setManagingOrder(false); setDraggedId('') }}>{t('page.orderDone')}</Button>
            </> : <Button size="small" onClick={() => setManagingOrder(true)}>{t('page.manageOrder')}</Button>}
          </div>

          {managingOrder ? <div className="agent-order-list">
            {rows.map(row => {
              const reorderable = canReorder(row.id)
              const reorderIndex = reorderableRows.findIndex(item => item.id === row.id)
              return <div
                key={row.id}
                className={`agent-order-option ${draggedId === row.id ? 'is-dragging' : ''} ${reorderable ? '' : 'is-fixed'}`}
                draggable={reorderable}
                onDragStart={(event: DragEvent<HTMLDivElement>) => {
                  if (!reorderable) return
                  setDraggedId(row.id)
                  event.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={event => {
                  if (!reorderable) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={event => {
                  if (!reorderable) return
                  event.preventDefault()
                  if (draggedId) move(draggedId, row.id)
                  setDraggedId('')
                }}
                onDragEnd={() => setDraggedId('')}
              >
                <UiIcon name="drag" size={15} className="agent-order-drag"/>
                <span className={`source-dot ${sourceDot(row.id)}`}/>
                <b>{row.displayName}</b>
                <span className="agent-order-buttons">
                  <IconButton size="small" disabled={!reorderable || reorderIndex <= 0} onClick={() => moveBy(row.id, -1)} aria-label={t('scope.moveUp', { agent: row.displayName })}><UiIcon name="arrow-big-up" size={13}/></IconButton>
                  <IconButton size="small" disabled={!reorderable || reorderIndex < 0 || reorderIndex === reorderableRows.length - 1} onClick={() => moveBy(row.id, 1)} aria-label={t('scope.moveDown', { agent: row.displayName })}><UiIcon name="arrow-big-down" size={13}/></IconButton>
                </span>
              </div>
            })}
          </div> : rows.map(row => {
            const assetCount = row.agent?.assetInventory.filter(asset => asset.type !== 'builtin').length ?? 0
            const status = integrationLifecycleState(row.agent, row.management, row.discovery, discoveryScanning, t)
            const packageState = row.management?.packageState
            const subtitle = row.management && packageState && !packageState.installed
              ? t('page.notAddedSubtitle')
              : !row.agent && packageState?.restartRequired
                ? t('page.waitingRestart')
                : row.agent
                  ? t('page.userAssets', { count: assetCount })
                  : t('page.detailsUnavailable')
            return <button
              key={row.id}
              className={`agent-source-option ${row.id === selectedSourceId ? 'is-active' : ''}`}
              onClick={() => selectRow(row.id, row.management?.isNew)}
              aria-current={row.id === selectedSourceId ? 'true' : undefined}
              title={status.title}
            >
              <span className={`source-dot large ${sourceDot(row.id)}`}/>
              <span className="agent-source-copy">
                <span className="agent-source-name-line">
                  <b>{row.displayName}</b>
                  {row.management?.isNew && <em>{t('status.new')}</em>}
                </span>
                <small>{subtitle}</small>
              </span>
              <span className={`agent-source-state ${status.className}`}>{status.label}</span>
            </button>
          })}
        </nav>
        <div className="agent-detail-pane">
          {selectedAgent ? <AgentCard
            key={selectedAgent.sourceId}
            model={model}
            agent={selectedAgent}
            management={selectedManagement}
            discovery={selectedDiscovery}
            discoveryScanning={discoveryScanning}
            discoveryError={snapshot.integrationDiscoveryError}
            policy={snapshot.capturePolicy}
            onCaptureChange={(id, enabled) => selectedManagement
              ? model.setIntegrationEnabled(id, enabled).then(() => undefined)
              : model.setSourceEnabled(id, enabled)}
            onInstall={installIntegration}
            onRemove={id => model.removeIntegration(id)}
            onAuthorize={(productId, capabilities) => model.authorizeIntegration(productId, capabilities)}
          /> : selectedManagement ? <IntegrationOnlyCard
            key={selectedManagement.integrationId}
            management={selectedManagement}
            discovery={selectedDiscovery}
            description={agentDescriptionKey[selectedManagement.integrationId]
              ? t(agentDescriptionKey[selectedManagement.integrationId]!)
              : t('description.fallback')}
            discoveryScanning={discoveryScanning}
            discoveryError={snapshot.integrationDiscoveryError}
            onChange={(id, enabled) => model.setIntegrationEnabled(id, enabled).then(() => undefined)}
            onInstall={installIntegration}
            onRemove={id => model.removeIntegration(id)}
          /> : null}
        </div>
      </div> : <div className="empty-state roomy">{t('page.empty')}</div>}
    </div>
  </main>
}

