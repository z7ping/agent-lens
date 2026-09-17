import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentAssetInventoryDto,
  AgentOverviewDto,
  PiEcosystemResourceTypeDto,
  PiEcosystemSearchResponseDto,
} from '@agent-lens/protocol'
import { searchPiEcosystem } from '../client/pi-ecosystem'
import {
  Button,
  Disclosure,
  Input,
  SelectMenu,
  StatusBadge,
  Toolbar,
  ToolbarGroup,
} from '../components/ui'

type TypeFilter = 'all' | PiEcosystemResourceTypeDto

type LocalPackageState = 'installed' | 'not-installed' | 'unknown'

interface LocalPackageInfo {
  assets: AgentAssetInventoryDto[]
  versions: string[]
}

function npmPackageSource(bindingSource: string | undefined): string | undefined {
  if (!bindingSource) return undefined
  const marker = ':package:'
  const markerIndex = bindingSource.indexOf(marker)
  if (markerIndex < 0) return undefined
  const packageSpec = bindingSource.slice(markerIndex + marker.length)
  if (!packageSpec.startsWith('npm:')) return undefined

  const npmSpec = packageSpec.slice('npm:'.length)
  if (!npmSpec) return undefined
  let versionIndex = -1
  if (npmSpec.startsWith('@')) {
    const slashIndex = npmSpec.indexOf('/')
    if (slashIndex < 0) return undefined
    versionIndex = npmSpec.indexOf('@', slashIndex + 1)
  } else {
    versionIndex = npmSpec.indexOf('@')
  }
  const packageName = (versionIndex >= 0 ? npmSpec.slice(0, versionIndex) : npmSpec).trim()
  return packageName ? `npm:${packageName}` : undefined
}

function localPackages(agent: AgentOverviewDto): Map<string, LocalPackageInfo> {
  const collected = new Map<string, { assets: Map<string, AgentAssetInventoryDto>; versions: Set<string> }>()
  for (const asset of agent.assetInventory) {
    for (const binding of asset.bindings) {
      const packageSource = npmPackageSource(binding.source)
      if (!packageSource) continue
      const current = collected.get(packageSource) ?? {
        assets: new Map<string, AgentAssetInventoryDto>(),
        versions: new Set<string>(),
      }
      current.assets.set(asset.id, asset)
      if (binding.version) current.versions.add(binding.version)
      collected.set(packageSource, current)
    }
  }
  return new Map([...collected.entries()].map(([source, value]) => [source, {
    assets: [...value.assets.values()],
    versions: [...value.versions].sort(),
  }]))
}

function packageInventoryComplete(agent: AgentOverviewDto): boolean {
  if (agent.assetInventoryStatus !== 'available') return false
  return agent.capabilities.some(capability =>
    capability.name === 'asset-discovery' && capability.status === 'available'
  )
}

function localPackageState(agent: AgentOverviewDto, localPackage: LocalPackageInfo | undefined): LocalPackageState {
  if (localPackage) return 'installed'
  return packageInventoryComplete(agent) ? 'not-installed' : 'unknown'
}

function localAssetType(asset: AgentAssetInventoryDto): PiEcosystemResourceTypeDto | 'other' {
  if (asset.type === 'extension' || asset.type === 'skill' || asset.type === 'prompt' || asset.type === 'theme') {
    return asset.type
  }
  return 'other'
}

export function PiEcosystemPanel({ agent }: { agent: AgentOverviewDto }) {
  const { t } = useTranslation('piEcosystem')
  const [queryDraft, setQueryDraft] = useState('')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [requestNonce, setRequestNonce] = useState(0)
  const [response, setResponse] = useState<PiEcosystemSearchResponseDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copiedPackage, setCopiedPackage] = useState('')
  const local = useMemo(() => localPackages(agent), [agent])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void searchPiEcosystem({
      query,
      ...(typeFilter === 'all' ? {} : { type: typeFilter }),
      limit: 20,
    }, controller.signal).then(result => {
      setResponse(result)
    }).catch(cause => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [query, requestNonce, typeFilter])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setQuery(queryDraft.trim())
    setRequestNonce(value => value + 1)
  }

  const copyInstallCommand = async (packageSource: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopiedPackage(packageSource)
      window.setTimeout(() => setCopiedPackage(current => current === packageSource ? '' : current), 1_500)
    } catch {
      setError(t('copyFailed'))
    }
  }

  const typeOptions = [
    { value: 'all', label: t('type.all') },
    { value: 'extension', label: t('type.extension') },
    { value: 'skill', label: t('type.skill') },
    { value: 'prompt', label: t('type.prompt') },
    { value: 'theme', label: t('type.theme') },
  ]

  return <section className="agent-primary-section">
    <div className="section-heading-row">
      <div><h3>{t('title')}</h3></div>
      {response?.stale
        ? <StatusBadge tone="warning">{t('stale')}</StatusBadge>
        : response && <span className="section-total">{response.items.length}</span>}
    </div>

    <form onSubmit={submit}>
      <Toolbar>
        <ToolbarGroup>
          <Input
            value={queryDraft}
            onChange={event => setQueryDraft(event.currentTarget.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
          />
          <SelectMenu
            ariaLabel={t('type.all')}
            value={typeFilter}
            options={typeOptions}
            variant="field"
            menuWidth={190}
            onChange={value => setTypeFilter(value as TypeFilter)}
          />
        </ToolbarGroup>
        <ToolbarGroup align="end">
          <Button type="submit" size="small" loading={loading}>{t('search')}</Button>
        </ToolbarGroup>
      </Toolbar>
    </form>

    {error && <div className="agent-path-error" role="alert"><b>{t('loadFailed')}</b> · {error}</div>}
    {!error && !loading && response?.items.length === 0 && <div className="muted-empty compact">{t('empty')}</div>}

    {response && response.items.length > 0 && <div className="agent-disclosures">
      {response.items.map(pkg => {
        const localPackage = local.get(pkg.packageSource)
        const localState = localPackageState(agent, localPackage)
        const localLabel = localState === 'installed'
          ? t('installed')
          : localState === 'not-installed'
            ? t('notInstalled')
            : t('localUnknown')
        return <Disclosure
          key={pkg.packageSource}
          className="disclosure-group"
          summary={pkg.packageName}
          summaryMeta={<StatusBadge tone={localState === 'installed' ? 'success' : localState === 'unknown' ? 'warning' : 'neutral'}>{localLabel}</StatusBadge>}
        >
          <div className="runtime-config-list">
            {pkg.description && <div className="runtime-config-row"><span>{t('description')}</span><span>{pkg.description}</span></div>}
            <div className="runtime-config-row"><span>{t('version')}</span><code>{pkg.version}</code></div>
            <div className="runtime-config-row"><span>{t('resourceTypes')}</span><span>{pkg.resourceTypes.length ? pkg.resourceTypes.map(type => t(`type.${type}`)).join(' · ') : t('typeUnknown')}</span></div>
            {localPackage?.versions.length ? <div className="runtime-config-row"><span>{t('localVersion')}</span><code>{localPackage.versions.join(' · ')}</code></div> : null}
            {localPackage && <div className="runtime-config-row"><span>{t('localAssets')}</span><span>{t('localAssetCount', { count: localPackage.assets.length })}</span></div>}
            {localPackage?.assets.map(asset => <div className="runtime-config-row" key={asset.id}><span>{asset.displayName ?? asset.canonicalName}</span><span>{t(`type.${localAssetType(asset)}`)}</span></div>)}
          </div>
          <Toolbar>
            <ToolbarGroup>
              <Button size="small" onClick={() => { void copyInstallCommand(pkg.packageSource, pkg.installCommand) }}>
                {copiedPackage === pkg.packageSource ? t('copied') : t('copyInstall')}
              </Button>
            </ToolbarGroup>
            <ToolbarGroup align="end">
              <Button size="small" onClick={() => { window.open(pkg.officialUrl, '_blank', 'noopener,noreferrer') }}>{t('officialDetail')}</Button>
            </ToolbarGroup>
          </Toolbar>
        </Disclosure>
      })}
    </div>}
  </section>
}

export const piEcosystemUiInternals = {
  npmPackageSource,
  localPackages,
  packageInventoryComplete,
  localPackageState,
}