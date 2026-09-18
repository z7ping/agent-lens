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
} from '../components/ui'

type TypeFilter = 'all' | PiEcosystemResourceTypeDto

type LocalPackageState = 'installed' | 'not-installed' | 'unknown'

interface LocalPackageInfo {
  assets: AgentAssetInventoryDto[]
  versions: string[]
}

function localPackages(agent: AgentOverviewDto): Map<string, LocalPackageInfo> {
  const collected = new Map<string, { assets: Map<string, AgentAssetInventoryDto>; versions: Set<string> }>()
  for (const asset of agent.assetInventory) {
    for (const binding of asset.bindings) {
      const packageIdentity = binding.packageIdentity
      if (!packageIdentity) continue
      const current = collected.get(packageIdentity) ?? {
        assets: new Map<string, AgentAssetInventoryDto>(),
        versions: new Set<string>(),
      }
      current.assets.set(asset.id, asset)
      if (binding.version) current.versions.add(binding.version)
      collected.set(packageIdentity, current)
    }
  }
  return new Map([...collected.entries()].map(([source, value]) => [source, {
    assets: [...value.assets.values()],
    versions: [...value.versions].sort(),
  }]))
}

function packageInventoryComplete(agent: AgentOverviewDto): boolean {
  if (agent.assetInventoryStatus !== 'available' || agent.installations.length === 0) return false
  return agent.installations.every(installation => installation.packageIdentityCoverage === 'complete')
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
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [copiedPackage, setCopiedPackage] = useState('')
  const local = useMemo(() => localPackages(agent), [agent])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    setResponse(null)
    void searchPiEcosystem({
      query,
      ...(typeFilter === 'all' ? {} : { type: typeFilter }),
      limit: 20,
    }, controller.signal).then(result => {
      setResponse(result)
    }).catch(cause => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [query, requestNonce, typeFilter])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setActionError('')
    setQuery(queryDraft.trim())
    setRequestNonce(value => value + 1)
  }

  const copyInstallCommand = async (packageSource: string, command: string) => {
    setActionError('')
    try {
      await navigator.clipboard.writeText(command)
      setCopiedPackage(packageSource)
      window.setTimeout(() => setCopiedPackage(current => current === packageSource ? '' : current), 1_500)
    } catch {
      setActionError(t('copyFailed'))
    }
  }

  const typeOptions = [
    { value: 'all', label: t('type.all') },
    { value: 'extension', label: t('type.extension') },
    { value: 'skill', label: t('type.skill') },
    { value: 'prompt', label: t('type.prompt') },
    { value: 'theme', label: t('type.theme') },
  ]

  return <section className="agent-primary-section pi-ecosystem-section">
    <div className="section-heading-row">
      <div><h3>{t('title')}</h3></div>
      {response?.stale
        ? <StatusBadge tone="warning">{t('stale')}</StatusBadge>
        : response && <span className="section-total">{response.items.length}</span>}
    </div>

    <form className="pi-ecosystem-controls" onSubmit={submit}>
      <Input
        className="pi-ecosystem-search"
        value={queryDraft}
        onChange={event => setQueryDraft(event.currentTarget.value)}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')}
      />
      <SelectMenu
        ariaLabel={t('type.all')}
        value={typeFilter}
        options={typeOptions}
        variant="toolbar"
        className="pi-ecosystem-type-filter"
        menuWidth={190}
        onChange={value => {
          setActionError('')
          setTypeFilter(value as TypeFilter)
        }}
      />
      <Button type="submit" size="small" loading={loading}>{t('search')}</Button>
    </form>

    {loadError && <div className="agent-path-error pi-ecosystem-error" role="alert"><b>{t('loadFailed')}</b> · {loadError}</div>}
    {actionError && <div className="agent-path-error pi-ecosystem-error" role="alert">{actionError}</div>}
    {!loadError && !loading && response?.items.length === 0 && <div className="muted-empty compact pi-ecosystem-empty">{t('empty')}</div>}

    {response && response.items.length > 0 && <div className="pi-package-list">
      {response.items.map(pkg => {
        const localPackage = local.get(pkg.packageSource)
        const localState = localPackageState(agent, localPackage)
        const localLabel = localState === 'installed'
          ? t('installed')
          : localState === 'not-installed'
            ? t('notInstalled')
            : t('localUnknown')
        const typeLabels = pkg.resourceTypes.length
          ? pkg.resourceTypes.map(type => ({ type, label: t(`type.${type}`) }))
          : [{ type: 'unknown', label: t('typeUnknown') }]
        return <Disclosure
          key={pkg.packageSource}
          className="pi-package-item"
          summary={<span className="pi-package-summary-copy">
            <span className="pi-package-title-line">
              <b className="pi-package-name">{pkg.packageName}</b>
              <span className="pi-package-types" aria-label={t('resourceTypes')}>
                {typeLabels.map(item => <span key={item.type}>{item.label}</span>)}
              </span>
            </span>
            {pkg.description && <span className="pi-package-summary-description">{pkg.description}</span>}
          </span>}
          summaryMeta={<span className="pi-package-summary-meta">
            <span className="pi-package-version"><small>{t('version')}</small><code>{pkg.version}</code></span>
            {localPackage?.versions.length
              ? <span className="pi-package-local-version"><small>{t('localVersion')}</small><code>{localPackage.versions.join(' · ')}</code></span>
              : null}
            <StatusBadge tone={localState === 'installed' ? 'success' : 'neutral'}>{localLabel}</StatusBadge>
          </span>}
        >
          <div className="pi-package-detail">
            <div className="pi-package-detail-grid">
              {pkg.description && <div className="pi-package-detail-row pi-package-description">
                <span>{t('description')}</span>
                <p>{pkg.description}</p>
              </div>}
              <div className="pi-package-detail-row">
                <span>{t('resourceTypes')}</span>
                <div className="pi-package-detail-types">
                  {typeLabels.map(item => <span key={item.type}>{item.label}</span>)}
                </div>
              </div>
              <div className="pi-package-detail-row">
                <span>{t('version')}</span>
                <code>{pkg.version}</code>
              </div>
              {localPackage?.versions.length ? <div className="pi-package-detail-row">
                <span>{t('localVersion')}</span>
                <code>{localPackage.versions.join(' · ')}</code>
              </div> : null}
              {localPackage && <div className="pi-package-detail-row">
                <span>{t('localAssets')}</span>
                <div className="pi-package-local-assets">
                  {localPackage.assets.map(asset => <span key={asset.id}>
                    <b>{asset.displayName ?? asset.canonicalName}</b>
                    <small>{t(`type.${localAssetType(asset)}`)}</small>
                  </span>)}
                </div>
              </div>}
            </div>

            <div className="pi-package-command">
              <code>{pkg.installCommand}</code>
              <Button size="small" onClick={() => { void copyInstallCommand(pkg.packageSource, pkg.installCommand) }}>
                {copiedPackage === pkg.packageSource ? t('copied') : t('copyInstall')}
              </Button>
            </div>

            <div className="pi-package-actions">
              <Button size="small" onClick={() => { window.open(pkg.officialUrl, '_blank', 'noopener,noreferrer') }}>{t('officialDetail')}</Button>
            </div>
          </div>
        </Disclosure>
      })}
    </div>}
  </section>
}

export const piEcosystemUiInternals = {
  localPackages,
  packageInventoryComplete,
  localPackageState,
}
