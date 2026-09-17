import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiveProductDto, LiveStartInputDto } from '@agent-lens/protocol'
import { liveApi } from '../client/live'
import { Button, Input, SelectMenu } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import { pickTaskProject, type TaskProjectOption } from './task-center'

export interface NewLiveTaskPanelProps {
  options: TaskProjectOption[]
  preferredProjectId?: string | undefined
  nativeDirectoryPicker: boolean
  projectLoading: boolean
  projectHasMore: boolean
  projectLoadingMore: boolean
  projectDiscoveryError: string
  projectSearchActive: boolean
  onProjectSearch(value: string): void
  onProjectLoadMore(): void
  onStarted(liveId: string, runtimeSessionId: string): void | Promise<void>
}

function createProducts(products: readonly LiveProductDto[]): LiveProductDto[] {
  return products.filter(product => product.capabilities.includes('create'))
}

export function NewLiveTaskPanel({
  options,
  preferredProjectId,
  nativeDirectoryPicker,
  projectLoading,
  projectHasMore,
  projectLoadingMore,
  projectDiscoveryError,
  projectSearchActive,
  onProjectSearch,
  onProjectLoadMore,
  onStarted,
}: NewLiveTaskPanelProps) {
  const { t } = useTranslation('task')
  const [products, setProducts] = useState<LiveProductDto[]>([])
  const [selectedLiveId, setSelectedLiveId] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [starting, setStarting] = useState(false)
  const [selectingDirectory, setSelectingDirectory] = useState(false)
  const [manualDirectoryOpen, setManualDirectoryOpen] = useState(false)
  const [manualDirectory, setManualDirectory] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [launchMode, setLaunchMode] = useState<'existing' | 'directory'>('existing')
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoadingProducts(true)
    void liveApi.products().then(value => {
      if (cancelled) return
      const next = createProducts(value)
      setProducts(next)
      setSelectedLiveId(current => next.some(item => item.liveId === current)
        ? current
        : next.find(item => item.availability.available)?.liveId ?? next[0]?.liveId ?? '')
    }, reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) setLoadingProducts(false)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const preferred = pickTaskProject(options, preferredProjectId)
    setSelectedKey(current => current || preferred?.key || '')
  }, [options, preferredProjectId])

  const product = products.find(item => item.liveId === selectedLiveId)
  const workspaceSupport = product?.startCapabilities.workspace ?? 'unsupported'
  const titleSupport = product?.startCapabilities.title ?? 'unsupported'
  const needsWorkspace = workspaceSupport === 'required'
  const acceptsWorkspace = workspaceSupport !== 'unsupported'
  const acceptsTitle = titleSupport !== 'unsupported'
  const available = product?.availability.available === true
  const selected = options.find(option => option.key === selectedKey)
  const productOptions = products.map(item => ({
    value: item.liveId,
    label: item.displayName,
    description: item.availability.available
      ? t('center.newTask.ready')
      : item.availability.reason || t('center.newTask.unavailable'),
  }))
  const projectOptions = useMemo(() => options.map(option => ({
    value: option.key,
    label: option.label,
    description: option.cwd,
    keywords: option.cwd,
  })), [options])
  const readiness = loadingProducts ? 'checking' : available ? 'ready' : 'unavailable'
  const readinessLabel = loadingProducts
    ? t('center.newTask.checking')
    : available
      ? t('center.newTask.ready')
      : product?.availability.reason || t('center.newTask.unavailable')
  const manualDirectoryVisible = !nativeDirectoryPicker || manualDirectoryOpen

  const start = async (workspace?: { cwd: string; label: string }) => {
    if (!product || starting || !available) return
    if (needsWorkspace && !workspace?.cwd) {
      setError(t('center.newTask.directoryRequired'))
      return
    }
    setStarting(true)
    setError('')
    try {
      const input: LiveStartInputDto = {
        ...(acceptsWorkspace && workspace?.cwd ? { workspacePath: workspace.cwd } : {}),
        ...(acceptsTitle && (taskTitle.trim() || workspace?.label)
          ? { title: taskTitle.trim() || workspace?.label }
          : {}),
      }
      const state = await liveApi.start(product.liveId, input)
      await onStarted(product.liveId, state.runtimeSessionId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStarting(false)
    }
  }

  const selectDirectoryAndStart = async () => {
    if (starting || selectingDirectory || !available || !acceptsWorkspace) return
    setSelectingDirectory(true)
    setError('')
    try {
      const cwd = await liveApi.selectProjectDirectory()
      if (!cwd) return
      const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
      await start({ cwd, label: parts.at(-1) ?? cwd })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSelectingDirectory(false)
    }
  }

  const startManualDirectory = async () => {
    const cwd = manualDirectory.trim()
    if (!cwd) {
      setError(t('center.newTask.directoryRequired'))
      return
    }
    const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
    await start({ cwd, label: parts.at(-1) ?? cwd })
  }

  return <div className="task-center-new">
    <section className="task-center-new-card">
      <header className="task-center-new-head">
        <div className="task-center-new-agent-mark" aria-hidden="true"><UiIcon name="agent" size={18}/></div>
        <div>
          <div className="task-center-new-kicker">{t('center.newTask.kicker')}</div>
          <h1>{t('center.newTask.title')}</h1>
        </div>
        <span className="task-center-new-readiness" data-state={readiness}><i/>{readinessLabel}</span>
      </header>

      <div className="task-center-new-fields">
        <label>
          <span>{t('center.newTask.agent')}</span>
          <SelectMenu
            value={selectedLiveId}
            options={productOptions}
            onChange={value => { setSelectedLiveId(value); setError('') }}
            ariaLabel={t('center.newTask.selectAgent')}
            placeholder={loadingProducts ? t('center.newTask.checking') : t('center.newTask.noAgent')}
            variant="field"
            menuWidth={360}
            disabled={loadingProducts || !products.length || starting}
          />
        </label>

        {acceptsTitle && <label className="task-center-new-task-title">
          <span>{t('center.newTask.taskTitle')}</span>
          <Input value={taskTitle} onChange={event => setTaskTitle(event.target.value)} placeholder={t('center.newTask.taskTitlePlaceholder')} disabled={starting} aria-label={t('center.newTask.taskTitleAria')}/>
        </label>}

        {acceptsWorkspace ? <>
          <div className="task-center-launch-modes" role="radiogroup" aria-label={t('center.newTask.launchModeAria')}>
            <Button className="task-center-launch-choice" role="radio" aria-checked={launchMode === 'existing'} onClick={() => { setLaunchMode('existing'); setError('') }}>
              <UiIcon name="folder-open" size={16}/>
              <span><b>{t('center.newTask.existingProject')}</b><small>{t('center.newTask.existingDescription')}</small></span>
            </Button>
            <Button className="task-center-launch-choice" role="radio" aria-checked={launchMode === 'directory'} onClick={() => { setLaunchMode('directory'); setError(''); if (!nativeDirectoryPicker) setManualDirectoryOpen(true) }}>
              <UiIcon name="plus" size={16}/>
              <span><b>{t('center.newTask.newProject')}</b><small>{t('center.newTask.newDescription')}</small></span>
            </Button>
          </div>

          {launchMode === 'existing'
            ? <section className="task-center-launch-panel" aria-label={t('center.newTask.existingProject')}>
                <SelectMenu
                  value={selectedKey}
                  options={projectOptions}
                  onChange={setSelectedKey}
                  ariaLabel={t('center.newTask.selectProjectAria')}
                  placeholder={options.length ? t('center.newTask.selectProject') : t('center.newTask.noProject')}
                  variant="field"
                  className="task-center-new-project-select"
                  menuWidth={420}
                  searchable
                  searchPlaceholder={t('center.newTask.searchProject')}
                  onSearchChange={onProjectSearch}
                  loading={projectLoading}
                  hasMore={projectHasMore}
                  onLoadMore={onProjectLoadMore}
                  loadingMore={projectLoadingMore}
                  loadMoreLabel={t('center.newTask.loadMoreProjects')}
                  disabled={!options.length && !projectHasMore && !projectLoading}
                />
                <div className="task-center-launch-panel-actions">
                  <Button variant="primary" loading={starting} disabled={!selected || !available} onClick={() => selected && void start(selected)}>{t('center.newTask.openExisting')} <UiIcon name="arrow-right" size={14}/></Button>
                </div>
              </section>
            : <section className="task-center-launch-panel" aria-label={t('center.newTask.newProject')}>
                {nativeDirectoryPicker && <div className="task-center-new-directory-actions">
                  <Button variant="primary" loading={selectingDirectory} disabled={!available || starting} onClick={() => void selectDirectoryAndStart()}>{t('center.newTask.selectDirectory')} <UiIcon name="arrow-right" size={14}/></Button>
                  <Button size="small" disabled={!available || starting} onClick={() => { setManualDirectoryOpen(value => !value); setError('') }}>{t('center.newTask.inputPath')}</Button>
                </div>}
                {manualDirectoryVisible && <div className="task-center-new-manual-directory">
                  <Input
                    value={manualDirectory}
                    onChange={event => setManualDirectory(event.target.value)}
                    placeholder={t('center.newTask.pathPlaceholder')}
                    aria-label={t('center.newTask.pathAria')}
                    disabled={starting}
                    onKeyDown={event => { if (event.key === 'Enter') void startManualDirectory() }}
                  />
                  <Button variant="primary" loading={starting} disabled={!available} onClick={() => void startManualDirectory()}>{t('center.newTask.openPath')} <UiIcon name="arrow-right" size={14}/></Button>
                  {!nativeDirectoryPicker && <p className="task-center-new-directory-hint">{t('center.newTask.pathHint')}</p>}
                </div>}
              </section>}
        </> : <div className="task-center-launch-panel-actions">
          <Button variant="primary" loading={starting} disabled={!available} onClick={() => void start()}>{t('center.newTask.startTask')} <UiIcon name="arrow-right" size={14}/></Button>
        </div>}
      </div>

      {error && <div className="pi-live-error" role="alert">{error}</div>}
      {projectDiscoveryError && acceptsWorkspace && <div className="task-center-project-hint" role="alert">{projectDiscoveryError}</div>}
      {acceptsWorkspace && !options.length && !projectLoading && !projectDiscoveryError && !projectSearchActive && <div className="task-center-project-hint">{t('center.newTask.noLocalProjects')}</div>}
    </section>
  </div>
}
