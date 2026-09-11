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
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { agentLabel, sourceDot, useOrderedAgents } from '../components/AgentScope'
import { usePinnedAgents } from '../components/PinnedAgentsProvider'
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
  agent: Pick<AgentOverviewDto, 'supported' | 'enabled' | 'detected'> | undefined,
  management: IntegrationManagementItemDto | undefined,
  discovery: IntegrationToolDiscoveryItemDto | undefined,
  discoveryScanning: boolean,
  t: TFunction,
): { label: string; title: string; className: string } {
  if (management) {
    const packageState = management.packageState
    if (!packageState) {
      return { label: t('status.managementUnavailable'), title: t('status.managementUnavailableTitle'), className: 'is-error' }
    }
    if (!packageState.installed) {
      if (discovery?.presence === 'error') {
        return { label: t('status.scanFailed'), title: discovery.reason || t('status.scanFailedTitle'), className: 'is-error' }
      }
      if (discovery?.presence === 'present' || discovery?.presence === 'data-only') {
        return { label: t('status.notAdded'), title: t('status.notAddedTitle'), className: 'is-not-added' }
      }
      if (discoveryScanning) {
        return { label: t('status.scanning'), title: t('status.scanningTitle'), className: 'is-scanning' }
      }
      return { label: t('status.notFound'), title: t('status.notFoundTitle'), className: 'is-missing' }
    }

    if (!management.enabled.configured) {
      if (management.enabled.restartRequired || packageState.restartRequired) {
        return { label: t('status.pendingRestart'), title: t('status.pendingRestartTitle'), className: 'is-history' }
      }
      return { label: t('status.disabled'), title: t('status.disabledTitle'), className: 'is-disabled' }
    }

    if (management.enabled.restartRequired || packageState.restartRequired) {
      return { label: t('status.pendingRestart'), title: t('status.pendingRestartTitle'), className: 'is-history' }
    }
    if (!agent?.detected && discovery?.presence !== 'present') {
      return { label: t('status.notDetected'), title: t('status.notDetectedTitle'), className: 'is-missing' }
    }
    if (management.availability === 'error') {
      return { label: t('status.abnormal'), title: t('status.abnormalTitle'), className: 'is-error' }
    }
    if (management.availability === 'unavailable') {
      return { label: t('status.unavailable'), title: t('status.unavailableTitle'), className: 'is-history' }
    }
    return { label: t('status.enabled'), title: t('status.enabledTitle'), className: 'is-enabled is-detected' }
  }

  if (!agent) {
    if (discoveryScanning) return { label: t('status.scanning'), title: t('status.scanningTitle'), className: 'is-scanning' }
    return { label: t('status.notDetected'), title: t('status.notDetectedTitle'), className: 'is-missing' }
  }
  if (!agent.supported) return { label: t('status.unsupported'), title: t('status.unsupportedTitle'), className: 'is-unsupported' }
  if (agent.detected) {
    if (!agent.enabled) return { label: t('status.disabled'), title: t('status.disabledTitle'), className: 'is-disabled' }
    return { label: t('status.enabled'), title: t('status.enabledTitle'), className: 'is-enabled is-detected' }
  }
  if (discovery?.presence === 'error') {
    return { label: t('status.scanFailed'), title: discovery.reason || t('status.scanFailedTitle'), className: 'is-error' }
  }
  if (discovery?.presence === 'data-only') {
    return { label: t('status.historyData'), title: t('status.historyDataTitle'), className: 'is-history' }
  }
  if (discoveryScanning) {
    return { label: t('status.scanning'), title: t('status.scanningTitle'), className: 'is-scanning' }
  }
  return { label: t('status.notDetected'), title: t('status.notDetectedTitle'), className: 'is-missing' }
}

function toolPresenceLabel(
  discovery: IntegrationToolDiscoveryItemDto | undefined,
  discoveryScanning: boolean,
  discoveryError: string,
  t: TFunction,
): string {
  if (discoveryError) return t('toolPresence.error')
  if (discovery?.presence === 'present') return t('toolPresence.present')
  if (discovery?.presence === 'data-only') return t('toolPresence.dataOnly')
  if (discovery?.presence === 'error') return t('toolPresence.error')
  if (discoveryScanning) return t('toolPresence.scanning')
  return t('toolPresence.absent')
}

function toolPresencePath(discovery: IntegrationToolDiscoveryItemDto | undefined): string | undefined {
  return discovery?.executable ?? discovery?.configRoot ?? discovery?.dataRoot
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

function IntegrationControl({
  agent,
  management,
  policy,
  onChange,
  onInstall,
  onAuthorize,
}: {
  agent: AgentOverviewDto
  management: IntegrationManagementItemDto | undefined
  policy: CapturePolicyResponseDto | null
  onChange(sourceId: string, enabled: boolean): Promise<void>
  onInstall(integrationId: string): Promise<IntegrationPackageOperationResponseDto>
  onAuthorize(
    productId: string,
    capabilities: readonly IntegrationAuthorizationCapabilityDto[],
  ): Promise<unknown>
}) {
  const { t } = useTranslation('agents')
  const [saving, setSaving] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [authorizationOpen, setAuthorizationOpen] = useState(false)
  const [authorizationSaved, setAuthorizationSaved] = useState(false)
  const settings = policy?.settings
  const configured = management?.enabled.configured
    ?? settings?.configuredEnabledSources.includes(agent.sourceId)
    ?? agent.enabled
  const effective = management?.enabled.effective
    ?? settings?.effectiveEnabledSources.includes(agent.sourceId)
    ?? agent.enabled
  const pending = configured !== effective
  const editable = management?.enabled.editable ?? settings?.editable ?? false
  const managedBy = management?.enabled.managedBy ?? settings?.managedBy
  const integrationAvailability = management?.availability ?? agent.integration?.availability
  const integrationCapabilities = management?.capabilities ?? agent.integration?.capabilities ?? []
  const pendingAuthorization = integrationCapabilities
    .filter(item => item.authorization === 'required')
    .map(item => item.capability)
    .filter((capability): capability is IntegrationAuthorizationCapabilityDto =>
      capability === 'hook' || capability === 'runtime' || capability === 'live'
    )

  const persistEnabled = async (enabled: boolean) => {
    setSaving(true)
    setError('')
    try {
      await onChange(management?.integrationId ?? agent.sourceId, enabled)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const install = async () => {
    if (!management || installing) return
    setInstalling(true)
    setError('')
    try {
      const result = await onInstall(management.integrationId)
      if (result.operation.status !== 'completed' || !result.state.installed) {
        throw new Error(result.operation.message || result.state.reason || t('integration.installFailed'))
      }
      await onChange(management.integrationId, true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setInstalling(false)
    }
  }

  const toggle = () => {
    if (!editable || saving) return
    void persistEnabled(!configured)
  }

  const authorize = async () => {
    if (!pendingAuthorization.length || saving) return
    setSaving(true)
    setError('')
    try {
      await onAuthorize(agent.productId, pendingAuthorization)
      setAuthorizationSaved(true)
      setAuthorizationOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (management && !management.packageState) {
    return <section className="source-capture-control">
      <div>
        <h3>{t('integration.title')}</h3>
        <p>{t('integration.packageLifecycleUnavailable')}</p>
      </div>
      <StatusBadge tone="danger">{t('status.managementUnavailable')}</StatusBadge>
    </section>
  }

  if (management?.packageState && !management.packageState.installed) {
    const canInstall = management.tool?.presence === 'present' || management.tool?.presence === 'data-only'
    return <section className="source-capture-control">
      <div>
        <h3>{t('integration.notAddedTitle')}</h3>
        <p>{canInstall ? t('integration.notAddedDescription') : t('integration.notDetectedDescription')}</p>
        {error && <p className="source-capture-error">{error}</p>}
      </div>
      <Button variant="primary" loading={installing} disabled={!canInstall} onClick={() => void install()}>
        {t('integration.addToAgentLens')}
      </Button>
    </section>
  }

  return <section className="source-capture-control">
    <div>
      <h3>{t('integration.title')}</h3>
      <p>{pending
        ? configured ? t('integration.pendingEnabled') : t('integration.pendingDisabled')
        : configured
          ? t('integration.enabledDescription')
          : t('integration.disabledDescription')}</p>
      {integrationAvailability && <div className="integration-availability">
        <span className="integration-availability-overall">
          <small>{t('integration.currentAvailability')}</small>
          <StatusBadge tone={integrationAvailabilityTone(integrationAvailability)} dot>
            {translatedLabel(integrationAvailabilityLabelKey, integrationAvailability, t)}
          </StatusBadge>
        </span>
        <span className="integration-capability-badges">
          {integrationCapabilities.map(item => <StatusBadge
            key={item.capability}
            tone={integrationAvailabilityTone(item.availability)}
            title={item.reasonCode ? translatedLabel(integrationReasonKey, item.reasonCode, t) : item.reason}
          >{translatedLabel(integrationCapabilityLabelKey, item.capability, t)} · {item.reasonCode === 'authorization-restart-required'
              ? t('integration.pendingRestart')
              : item.authorization === 'required'
                ? t('integration.pendingAuthorization')
                : translatedLabel(integrationAvailabilityLabelKey, item.availability, t)}</StatusBadge>)}
        </span>
      </div>}
      {configured && pendingAuthorization.length > 0 && !authorizationSaved && <div className="integration-authorization-action">
        <Button size="small" disabled={saving} onClick={() => setAuthorizationOpen(true)}>{t('integration.authorizeControl')}</Button>
        <span>{t('integration.authorizeHint')}</span>
      </div>}
      {authorizationSaved && <p className="source-capture-note">{t('integration.authorizationSaved')}</p>}
      {!editable && managedBy && <p className="source-capture-note">{t('integration.managedReadonly', {
        manager: managedBy === 'environment' ? t('integration.environmentManager') : t('integration.runtimeManager'),
      })}</p>}
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
    ><span aria-hidden="true"/><b>{saving ? t('integration.saving') : configured ? t('integration.enabled') : t('integration.disabled')}</b></button>
    <Dialog
      open={authorizationOpen}
      title={t('integration.dialogTitle', { agent: agentLabel(agent.sourceId, agent.displayName) })}
      description={t('integration.dialogDescription')}
      onClose={() => { if (!saving) setAuthorizationOpen(false) }}
      closeDisabled={saving}
      footer={<>
        <Button disabled={saving} onClick={() => setAuthorizationOpen(false)}>{t('integration.cancel')}</Button>
        <Button variant="primary" loading={saving} onClick={() => void authorize()}>{t('integration.confirm')}</Button>
      </>}
    >
      <div className="integration-authorization-list">
        {pendingAuthorization.map(capability => <div key={capability}>
          <b>{translatedLabel(integrationCapabilityLabelKey, capability, t)}</b>
          <span>{capability === 'runtime'
            ? t('integration.runtimePermission')
            : capability === 'live'
              ? t('integration.livePermission')
              : t('integration.hookPermission')}</span>
        </div>)}
      </div>
      <p className="integration-authorization-note">{t('integration.persistedNote')}</p>
    </Dialog>
  </section>
}

function IntegrationAdvancedActions({
  management,
  label,
  onChange,
  onRemove,
}: {
  management: IntegrationManagementItemDto | undefined
  label: string
  onChange(integrationId: string, enabled: boolean): Promise<void>
  onRemove(integrationId: string): Promise<IntegrationPackageOperationResponseDto>
}) {
  const { t } = useTranslation('agents')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  if (!management?.packageState?.installed) return null

  const remove = async () => {
    if (saving) return
    setSaving(true)
    setMessage('')
    setError('')
    try {
      if (management.enabled.configured) {
        await onChange(management.integrationId, false)
      }
      if (management.enabled.effective) {
        setMessage(t('integration.uninstallRestartRequired'))
        return
      }
      const result = await onRemove(management.integrationId)
      if (result.operation.status !== 'completed' || result.state.installed) {
        throw new Error(result.operation.message || result.state.reason || t('integration.uninstallFailed'))
      }
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return <details className="disclosure-group integration-advanced">
    <summary><DisclosureChevron/><span>{t('integration.advancedTitle')}</span></summary>
    <div className="integration-advanced-body">
      <div>
        <b>{t('integration.uninstallTitle')}</b>
        <span>{t('integration.uninstallDescription')}</span>
        {management.packageState.installedVersion && <small>{t('integration.installedVersion', { version: management.packageState.installedVersion })}</small>}
      </div>
      <Button variant="danger" size="small" onClick={() => { setMessage(''); setError(''); setOpen(true) }}>
        {t('integration.uninstall')}
      </Button>
    </div>
    <Dialog
      open={open}
      title={t('integration.uninstallDialogTitle', { agent: label })}
      description={t('integration.uninstallDialogDescription')}
      onClose={() => { if (!saving) setOpen(false) }}
      closeDisabled={saving}
      footer={<>
        <Button disabled={saving} onClick={() => setOpen(false)}>{t('integration.cancel')}</Button>
        <Button variant="danger" loading={saving} onClick={() => void remove()}>
          {management.enabled.effective ? t('integration.disableBeforeUninstall') : t('integration.confirmUninstall')}
        </Button>
      </>}
    >
      {message && <p className="integration-uninstall-note">{message}</p>}
      {error && <p className="source-capture-error">{error}</p>}
      <p className="integration-authorization-note">{t('integration.uninstallKeepsHistory')}</p>
    </Dialog>
  </details>
}

function IntegrationOnlyCard({
  management,
  discovery,
  discoveryScanning,
  discoveryError,
  onChange,
  onInstall,
  onRemove,
}: {
  management: IntegrationManagementItemDto
  discovery: IntegrationToolDiscoveryItemDto | undefined
  discoveryScanning: boolean
  discoveryError: string
  onChange(integrationId: string, enabled: boolean): Promise<void>
  onInstall(integrationId: string): Promise<IntegrationPackageOperationResponseDto>
  onRemove(integrationId: string): Promise<IntegrationPackageOperationResponseDto>
}) {
  const { t } = useTranslation('agents')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const status = captureState(undefined, management, discovery, discoveryScanning, t)
  const packageState = management.packageState
  const presencePath = toolPresencePath(discovery)
  const canInstall = discovery?.presence === 'present' || discovery?.presence === 'data-only'

  const install = async () => {
    if (!packageState || packageState.installed || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await onInstall(management.integrationId)
      if (result.operation.status !== 'completed' || !result.state.installed) {
        throw new Error(result.operation.message || result.state.reason || t('integration.installFailed'))
      }
      await onChange(management.integrationId, true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const toggle = async () => {
    if (!packageState?.installed || !management.enabled.editable || saving) return
    setSaving(true)
    setError('')
    try {
      await onChange(management.integrationId, !management.enabled.configured)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return <article className="agent-card" data-source={management.integrationId}>
    <header className="agent-card-head">
      <div className="agent-identity">
        <span className={`source-dot large ${sourceDot(management.integrationId)}`}/>
        <div>
          <h2>{management.displayName}</h2>
          <p>{agentDescriptionKey[management.integrationId] ? t(agentDescriptionKey[management.integrationId]!) : t('description.fallback')}</p>
        </div>
      </div>
      <span className={`agent-status ${status.className}`} title={status.title}>{status.label}</span>
    </header>

    <div className="agent-installation">
      <span className="agent-tool-presence"><small>{t('toolPresence.label')}</small><b data-presence={discoveryError ? 'error' : discovery?.presence ?? (discoveryScanning ? 'scanning' : 'absent')}>{toolPresenceLabel(discovery, discoveryScanning, discoveryError, t)}</b></span>
      <span><small>{t('installation.integrationVersion')}</small><b>{packageState?.installedVersion ?? packageState?.availableVersion ?? t('installation.notAdded')}</b></span>
      {presencePath && <span className="agent-config"><small>{t('toolPresence.location')}</small><code title={presencePath}>{shortPath(presencePath, 52)}</code></span>}
    </div>

    {discovery?.presence === 'data-only' && <p className="agent-discovery-note">{t('toolPresence.dataOnlyHint')}</p>}
    {(discoveryError || discovery?.presence === 'error') && <p className="agent-discovery-note is-error" title={discoveryError || discovery?.reason}>{t('toolPresence.errorHint')}</p>}

    <section className="source-capture-control">
      <div>
        <h3>{packageState?.installed ? t('integration.title') : t('integration.notAddedTitle')}</h3>
        <p>{!packageState
          ? t('integration.packageLifecycleUnavailable')
          : packageState.installed
            ? packageState.restartRequired || management.enabled.restartRequired
              ? t('integration.pendingRestartDescription')
              : management.enabled.configured
                ? t('integration.enabledDescription')
                : t('integration.disabledDescription')
            : canInstall
              ? t('integration.notAddedDescription')
              : t('integration.notDetectedDescription')}</p>
        {error && <p className="source-capture-error">{error}</p>}
      </div>
      {!packageState
        ? <StatusBadge tone="danger">{t('status.managementUnavailable')}</StatusBadge>
        : packageState.installed
          ? <button
              type="button"
              role="switch"
              aria-checked={management.enabled.configured}
              className="source-capture-switch"
              data-enabled={management.enabled.configured || undefined}
              disabled={!management.enabled.editable || saving}
              onClick={() => void toggle()}
            ><span aria-hidden="true"/><b>{saving ? t('integration.saving') : management.enabled.configured ? t('integration.enabled') : t('integration.disabled')}</b></button>
          : <Button variant="primary" loading={saving} disabled={!canInstall} onClick={() => void install()}>{t('integration.addToAgentLens')}</Button>}
    </section>

    <section className="agent-primary-section integration-awaiting-detail">
      <div className="section-heading-row"><div><h3>{t('integration.detailsPendingTitle')}</h3><p>{packageState?.installed ? t('integration.detailsPendingRestart') : t('integration.detailsPendingInstall')}</p></div></div>
    </section>

    <section className="agent-secondary">
      <IntegrationAdvancedActions
        management={management}
        label={management.displayName}
        onChange={onChange}
        onRemove={onRemove}
      />
    </section>
  </article>
}

function AgentCard({ agent, management, discovery, discoveryScanning, discoveryError, policy, onCaptureChange, onInstall, onRemove, onAuthorize }: {
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
  const status = captureState(agent, management, discovery, discoveryScanning, t)
  const presencePath = toolPresencePath(discovery)
  const configPath = installation?.configRoot ?? discovery?.configRoot ?? discovery?.dataRoot

  return <article className="agent-card" data-source={agent.sourceId} data-enabled={String(agent.enabled)}>
    <header className="agent-card-head">
      <div className="agent-identity">
        <span className={`source-dot large ${sourceDot(agent.sourceId)}`}/>
        <div><h2>{agentLabel(agent.sourceId, agent.displayName)}</h2><p>{agentDescriptionKey[agent.sourceId] ? t(agentDescriptionKey[agent.sourceId]!) : t('description.fallback')}</p></div>
      </div>
      <span className={`agent-status ${status.className}`} title={status.title}>{status.label}</span>
    </header>

    <div className="agent-installation">
      <span className="agent-tool-presence"><small>{t('toolPresence.label')}</small><b data-presence={discoveryError ? 'error' : discovery?.presence ?? (discoveryScanning ? 'scanning' : 'absent')}>{toolPresenceLabel(discovery, discoveryScanning, discoveryError, t)}</b></span>
      <span><small>{t('installation.version')}</small><b>{installation?.version ?? (agent.detected ? t('installation.versionUnavailable') : t('installation.notDetected'))}</b></span>
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
        <summary><DisclosureChevron/><span>{t('sections.assemblyPaths')}</span><span className="disclosure-count">{bindings.length}</span></summary>
        <div className="assembly-list">
          {installation?.executable && <div><span>{t('sections.executable')}</span><code>{installation.executable}</code></div>}
          {installation?.configRoot && <div><span>{t('sections.config')}</span><code>{installation.configRoot}</code></div>}
          {installation?.dataRoot && <div><span>{t('sections.data')}</span><code>{installation.dataRoot}</code></div>}
          {visibleBindings.map(({ asset, binding }) => binding.path ? <div key={binding.id}><span>{translatedLabel(assetTypeLabelKey, asset.type, t)}</span><code>{binding.path}</code></div> : null)}
          {!installation && !bindings.some(item => item.binding.path) && <div className="muted-empty compact">{t('sections.noAssemblyPaths')}</div>}
        </div>
        {bindings.length > ASSEMBLY_PATH_LIMIT && <button className="show-more-button" onClick={() => setShowAllBindings(value => !value)}>{showAllBindings ? t('collapse') : t('sections.showMorePaths', { count: bindings.length - ASSEMBLY_PATH_LIMIT })}</button>}
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
  </article>
}

export function AgentsPage({ model, sourceId, onSourceIdChange }: { model: AgentLensClientModel; sourceId: string; onSourceIdChange(sourceId: string): void }) {
  const { t } = useTranslation('agents')
  const snapshot = useClientSnapshot(model)
  const agents = useOrderedAgents(snapshot.facets?.agents ?? [])
  const items = useOrderedAgents(snapshot.agents?.items ?? [])
  const fallbackSourceId = items.find(item => item.detected)?.sourceId || items[0]?.sourceId || ''
  const selectedSourceId = items.some(item => item.sourceId === sourceId) ? sourceId : fallbackSourceId
  const selectedAgent = items.find(item => item.sourceId === selectedSourceId)
  const discovery = snapshot.integrationDiscovery
  const discoveryScanning = snapshot.integrationDiscoveryLoading
    || snapshot.integrationDiscoveryRescanning
    || discovery?.status === 'scanning'
  const managementByProduct = new Map((snapshot.integrationManagement?.items ?? []).map(item => [item.productId, item]))
  const managementById = new Map((snapshot.integrationManagement?.items ?? []).map(item => [item.integrationId, item]))
  const discoveryByProduct = new Map((discovery?.items ?? []).map(item => [item.productId, item]))
  const discoveryErrors = discovery?.items.filter(item => item.presence === 'error') ?? []
  const selectedManagement = selectedAgent
    ? managementByProduct.get(selectedAgent.productId) ?? managementById.get(selectedAgent.sourceId)
    : undefined
  const selectedDiscovery = selectedManagement?.tool ?? (selectedAgent
    ? discoveryByProduct.get(selectedAgent.productId) ?? discoveryByProduct.get(selectedAgent.sourceId)
    : undefined)
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

  return <main className="workspace-page">
    <div className="page-content agents-content">
      <CompactPageHeading title={t('page.title')} description={t('page.description')}>
        <Toolbar aria-label={t('page.scanToolbar')} className="agents-rescan-toolbar">
          <Button size="small" loading={scanBusy} disabled={scanBusy} onClick={() => void model.rescanAgentEnvironment().catch(() => undefined)}><UiIcon name="refresh" size={14}/>{scanBusy ? t('page.scanning') : t('page.rescan')}</Button>
          {rescanStatus}
        </Toolbar>
      </CompactPageHeading>
      {items.length ? <div className="agents-browser">
        <nav className="agent-source-nav" aria-label={t('page.list')}>
          <div className="agent-source-nav-head"><b>{t('page.localAgents')}</b><span>{items.length}</span></div>
          {items.map(agent => {
            const assetCount = agent.assetInventory.filter(asset => asset.type !== 'builtin').length
            const agentDiscovery = discoveryByProduct.get(agent.productId) ?? discoveryByProduct.get(agent.sourceId)
            const agentManagement = managementByProduct.get(agent.productId) ?? managementById.get(agent.sourceId)
            const status = captureState(agent, agentManagement, agentDiscovery, discoveryScanning, t)
            return <button key={agent.sourceId} className={`agent-source-option ${agent.sourceId === selectedSourceId ? 'is-active' : ''}`} onClick={() => onSourceIdChange(agent.sourceId)} aria-current={agent.sourceId === selectedSourceId ? 'true' : undefined} title={status.title}>
              <span className={`source-dot large ${sourceDot(agent.sourceId)}`}/>
              <span className="agent-source-copy"><b>{agentLabel(agent.sourceId, agent.displayName)}</b><small>{t('page.userAssets', { count: assetCount })}</small></span>
              <span className={`agent-source-state ${status.className}`}>{status.label}</span>
            </button>
          })}
        </nav>
        <div className="agent-detail-pane">{selectedAgent && <AgentCard
          key={selectedAgent.sourceId}
          agent={selectedAgent}
          management={selectedManagement}
          discovery={selectedDiscovery}
          discoveryScanning={discoveryScanning}
          discoveryError={snapshot.integrationDiscoveryError}
          policy={snapshot.capturePolicy}
          onCaptureChange={(id, enabled) => selectedManagement
            ? model.setIntegrationEnabled(id, enabled).then(() => undefined)
            : model.setSourceEnabled(id, enabled)}
          onAuthorize={(productId, capabilities) => model.authorizeIntegration(productId, capabilities)}
        />}</div>
      </div> : <div className="empty-state roomy">{t('page.empty')}</div>}
    </div>
  </main>
}