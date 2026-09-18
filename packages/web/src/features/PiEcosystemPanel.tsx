import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentAssetInventoryDto,
  AgentOverviewDto,
  PiEcosystemPackageDetailsResponseDto,
  PiEcosystemResourceTypeDto,
  PiEcosystemSearchResponseDto,
  PiEcosystemSortDto,
} from '@agent-lens/protocol'
import {
  loadPiEcosystemPackageDetails,
  searchPiEcosystem,
} from '../client/pi-ecosystem'
import {
  Button,
  Disclosure,
  Input,
  SelectMenu,
  StatusBadge,
} from '../components/ui'

type TypeFilter = 'all' | PiEcosystemResourceTypeDto

type LocalPackageState = 'installed' | 'not-installed' | 'unknown'
type PackageDetailState = 'loading' | 'loaded' | 'failed'

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
  // Generic asset discovery coverage is not Package identity coverage. Until #248 supplies an
  // explicit package-identity capability, absence of a local match must remain unknown.
  return agent.capabilities.some(capability =>
    capability.name === 'package-identity-discovery' && capability.status === 'available'
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

function formatMonthlyDownloads(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

export function PiEcosystemPanel({ agent }: { agent: AgentOverviewDto }) {
  const { t, i18n } = useTranslation('piEcosystem')
  const [queryDraft, setQueryDraft] = useState('')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [sort, setSort] = useState<PiEcosystemSortDto>('downloads')
  const [requestNonce, setRequestNonce] = useState(0)
  const [response, setResponse] = useState<PiEcosystemSearchResponseDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [copiedPackage, setCopiedPackage] = useState('')
  const [details, setDetails] = useState<Record<string, PiEcosystemPackageDetailsResponseDto>>({})
  const [detailStates, setDetailStates] = useState<Record<string, PackageDetailState>>({})
  const local = useMemo(() => localPackages(agent), [agent])
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    void searchPiEcosystem({
      query,
      ...(typeFilter === 'all' ? {} : { type: typeFilter }),
      sort,
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
  }, [query, requestNonce, sort, typeFilter])

  useEffect(() => {
    if (!response?.items.length) return
    const targets = response.items.filter(pkg =>
      pkg.resourceTypes.length === 0
      && Boolean(pkg.version)
      && details[pkg.packageSource]?.version !== pkg.version
    )
    if (!targets.length) return

    const controller = new AbortController()
    setDetailStates(current => {
      const next = { ...current }
      for (const pkg of targets) next[pkg.packageSource] = 'loading'
      return next
    })

    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < targets.length && !controller.signal.aborted) {
        const pkg = targets[nextIndex]
        nextIndex += 1
        if (!pkg) continue
        try {
          if (!pkg.version) continue
          const detail = await loadPiEcosystemPackageDetails({
            packageName: pkg.packageName,
            version: pkg.version,
          }, controller.signal)
          setDetails(current => ({ ...current, [pkg.packageSource]: detail }))
          setDetailStates(current => ({ ...current, [pkg.packageSource]: 'loaded' }))
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === 'AbortError') return
          setDetailStates(current => ({ ...current, [pkg.packageSource]: 'failed' }))
        }
      }
    }

    void Promise.all(Array.from(
      { length: Math.min(4, targets.length) },
      () => worker(),
    ))
    return () => controller.abort()
  }, [response])

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
  const sortOptions = [
    { value: 'downloads', label: t('sort.downloads') },
    { value: 'recent', label: t('sort.recent') },
  ]
  const visibleCount = typeFilter === 'all'
    ? response?.upstreamTotal ?? response?.items.length ?? 0
    : response?.items.length ?? 0

  return <section className="pi-ecosystem-section">
    <div className="section-heading-row">
      <div><h3>{t('title')}</h3></div>
      <div className="pi-ecosystem-heading-status">
        {loading && <StatusBadge tone="accent">{t(response ? 'refreshing' : 'loading')}</StatusBadge>}
        {!loading && response?.stale && <StatusBadge tone="warning">{t('stale')}</StatusBadge>}
        {response && <span className="section-total" title={t('catalogCount', { count: visibleCount })}>{visibleCount}</span>}
      </div>
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
        ariaLabel={t('typeFilter')}
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
      <SelectMenu
        ariaLabel={t('sort.label')}
        value={sort}
        options={sortOptions}
        variant="toolbar"
        className="pi-ecosystem-sort-filter"
        menuWidth={180}
        onChange={value => {
          setActionError('')
          setSort(value as PiEcosystemSortDto)
        }}
      />
      <Button type="submit" size="small" aria-busy={loading || undefined}>
        {loading ? t('searching') : t('search')}
      </Button>
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
        const detail = pkg.version && details[pkg.packageSource]?.version === pkg.version
          ? details[pkg.packageSource]
          : undefined
        const resourceTypes = pkg.resourceTypes.length ? pkg.resourceTypes : detail?.resourceTypes ?? []
        const typeLabels = resourceTypes.length
          ? resourceTypes.map(type => ({ type, label: t(`type.${type}`) }))
          : [{
              type: 'unknown',
              label: detailStates[pkg.packageSource] === 'loading' ? t('typeLoading') : t('typeUnknown'),
            }]
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
            <span className="pi-package-downloads">
              <small>{t('monthlyDownloads')}</small>
              <strong>{pkg.monthlyDownloads === undefined
                ? '—'
                : formatMonthlyDownloads(pkg.monthlyDownloads, locale)}</strong>
            </span>
            <span className="pi-package-version"><small>{t('version')}</small><code>{pkg.version ?? '—'}</code></span>
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
                <span>{t('monthlyDownloads')}</span>
                <strong>{pkg.monthlyDownloads === undefined
                  ? t('downloadsUnknown')
                  : t('downloadsPerMonth', { count: formatMonthlyDownloads(pkg.monthlyDownloads, locale) })}</strong>
              </div>
              <div className="pi-package-detail-row">
                <span>{t('version')}</span>
                <code>{pkg.version ?? '—'}</code>
              </div>
              {pkg.publishedAt && <div className="pi-package-detail-row">
                <span>{t('publishedAt')}</span>
                <span>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(pkg.publishedAt))}</span>
              </div>}
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
  npmPackageSource,
  localPackages,
  packageInventoryComplete,
  localPackageState,
  formatMonthlyDownloads,
}
