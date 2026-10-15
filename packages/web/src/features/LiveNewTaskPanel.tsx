import { useEffect, useMemo, useRef, useState } from 'react'
import type { LiveProductDto, LiveRuntimeStateDto, LiveStartInputDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { liveApi } from '../client/live'
import { selectHostProjectDirectory, validateHostProjectDirectory } from '../client/host-directory'
import { Button, Input, SelectMenu, StatusBadge } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import { AgentLogo } from '../components/AgentLogo'
import { pickTaskProject, type TaskProjectOption } from './task-center'

export interface LiveNewTaskPanelProps {
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
  onStarted(liveId: string, state: LiveRuntimeStateDto): void | Promise<void>
}

function createProducts(items: readonly LiveProductDto[]): LiveProductDto[] {
  return items.filter(item => item.capabilities.includes('create'))
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

/** Accept only host-absolute paths; the Live start API remains authoritative for existence and permissions. */
function isAbsoluteWorkspacePath(value: string): boolean {
  const path = value.trim()
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path)
}

export function LiveNewTaskPanel({
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
}: LiveNewTaskPanelProps) {
  const { t } = useTranslation('task')
  const [products, setProducts] = useState<LiveProductDto[]>([])
  const [productsLoading, setProductsLoading] = useState(true)
  const [productsError, setProductsError] = useState('')
  const [selectedLiveId, setSelectedLiveId] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const projectSelectionInitializedRef = useRef(false)
  const [starting, setStarting] = useState(false)
  const [selectingDirectory, setSelectingDirectory] = useState(false)
  const [manualDirectory, setManualDirectory] = useState('')
  const [directoryCheck, setDirectoryCheck] = useState<{ path: string; valid: boolean; error?: string }>()
  const [taskTitle, setTaskTitle] = useState('')
  const [launchMode, setLaunchMode] = useState<'existing' | 'directory'>('existing')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setProductsLoading(true)
    setProductsError('')
    void liveApi.products().then(items => {
      if (cancelled) return
      const next = createProducts(items)
      setProducts(next)
      setSelectedLiveId(current => {
        if (current && next.some(item => item.liveId === current)) return current
        return next.find(item => item.availability.available)?.liveId ?? next[0]?.liveId ?? ''
      })
    }, reason => {
      if (!cancelled) {
        setProducts([])
        setProductsError(reason instanceof Error ? reason.message : String(reason))
      }
    }).finally(() => {
      if (!cancelled) setProductsLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    // 仅初次默认选择；搜索/分页刷新不能悄悄把已选工作目录换成其他项目。
    if (projectSelectionInitializedRef.current || projectSearchActive || !options.length) return
    projectSelectionInitializedRef.current = true
    setSelectedKey(pickTaskProject(options, preferredProjectId)?.key ?? '')
  }, [options, preferredProjectId, projectSearchActive])

  const selectedProduct = products.find(item => item.liveId === selectedLiveId)
  const startCapabilities = selectedProduct?.startCapabilities ?? {
    workspace: 'unsupported' as const,
    title: 'unsupported' as const,
  }
  const workspaceSupported = startCapabilities.workspace !== 'unsupported'
  const titleSupported = startCapabilities.title !== 'unsupported'

  const directoryPath = manualDirectory.trim()
  useEffect(() => {
    if (!workspaceSupported || !isAbsoluteWorkspacePath(directoryPath)) {
      setDirectoryCheck(undefined)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void validateHostProjectDirectory(directoryPath, controller.signal).then(
        () => { if (!controller.signal.aborted) setDirectoryCheck({ path: directoryPath, valid: true }) },
        reason => {
          if (!controller.signal.aborted) setDirectoryCheck({
            path: directoryPath,
            valid: false,
            error: reason instanceof Error ? reason.message : String(reason),
          })
        },
      )
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [directoryPath, workspaceSupported])
  const currentDirectoryCheck = directoryCheck?.path === directoryPath ? directoryCheck : undefined
  const directoryIsVerified = currentDirectoryCheck?.valid === true
  const selectedProject = options.find(option => option.key === selectedKey)
  const projectOptions = useMemo(
    () => options.map(option => ({ value: option.key, label: option.label, description: option.cwd, keywords: option.cwd })),
    [options],
  )
  const recentDirectories = useMemo(() => {
    const seen = new Set<string>()
    return [...options]
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .filter(option => {
        if (!option.cwd.trim() || seen.has(option.cwd)) return false
        seen.add(option.cwd)
        return true
      })
      .slice(0, 3)
  }, [options])
  const directoryIsInvalid = Boolean(directoryPath) && !isAbsoluteWorkspacePath(directoryPath)
  const agentOptions = useMemo(() => products.map(product => ({
    value: product.liveId,
    label: product.displayName,
    leading: <AgentLogo sourceId={product.productId} size="compact"/>,
    description: product.availability.available
      ? t('center.newTask.ready')
      : t('center.newTask.agentUnavailableShort'),
  })), [products, t])

  const available = Boolean(selectedProduct?.availability.available)
  const readiness = productsLoading
    ? { state: 'checking', label: t('center.newTask.checkingAgents') }
    : available
      ? { state: 'ready', label: t('center.newTask.agentReady', { agent: selectedProduct?.displayName ?? '' }) }
      : { state: 'unavailable', label: selectedProduct?.availability.reason
          ? t('center.newTask.agentUnavailableReason', { agent: selectedProduct.displayName, reason: selectedProduct.availability.reason })
          : t('center.newTask.agentUnavailable', { agent: selectedProduct?.displayName ?? '' }) }

  const start = async (workspacePath?: string, fallbackTitle?: string) => {
    if (starting || !selectedProduct || !available) return
    if (startCapabilities.workspace === 'required' && !workspacePath?.trim()) {
      setError(t('center.newTask.directoryRequired'))
      return
    }
    setStarting(true)
    setError('')
    try {
      const input: LiveStartInputDto = {}
      if (workspaceSupported && workspacePath?.trim()) input.workspacePath = workspacePath.trim()
      if (titleSupported) {
        const title = taskTitle.trim() || fallbackTitle?.trim()
        if (title) input.title = title
      }
      const state = await liveApi.start(selectedProduct.liveId, input)
      await onStarted(selectedProduct.liveId, state)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStarting(false)
    }
  }

  const selectDirectory = async () => {
    if (starting || selectingDirectory || !workspaceSupported) return
    setSelectingDirectory(true)
    setError('')
    try {
      const path = await selectHostProjectDirectory()
      if (path) setManualDirectory(path)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSelectingDirectory(false)
    }
  }

  const startManualDirectory = async () => {
    const path = manualDirectory.trim()
    if (!path) {
      setError(t('center.newTask.directoryRequired'))
      return
    }
    if (!isAbsoluteWorkspacePath(path)) {
      setError(t('center.newTask.directoryInvalid'))
      return
    }
    if (!directoryIsVerified) {
      setError(currentDirectoryCheck?.error || t('center.newTask.directoryChecking'))
      return
    }
    await start(path, basename(path))
  }

  const selectLaunchMode = (mode: 'existing' | 'directory') => {
    setLaunchMode(mode)
    setError('')
  }

  return <div className="task-center-new">
    <section className="task-center-new-card">
      <header className="task-center-new-head">
        <div className="task-center-new-agent-mark" aria-hidden="true"><UiIcon name="agent" size={16}/></div>
        <div className="task-center-new-heading">
          <div className="task-center-new-kicker">{t('center.newTask.kicker')}</div>
          <h1>{t('center.newTask.title')}</h1>
          <StatusBadge
            className="task-center-new-readiness"
            tone={readiness.state === 'unavailable' ? 'danger' : readiness.state === 'ready' ? 'success' : 'neutral'}
            dot
          >
            {readiness.label}
          </StatusBadge>
        </div>
      </header>

      <div className="task-center-new-fields">
        <label className="task-center-new-agent-field">
          <span>{t('center.newTask.agent')}</span>
          <SelectMenu
            value={selectedLiveId}
            onChange={value => { setSelectedLiveId(value); setError('') }}
            ariaLabel={t('center.newTask.selectAgentAria')}
            placeholder={productsLoading ? t('center.newTask.checkingAgents') : t('center.newTask.selectAgent')}
            options={agentOptions}
            disabled={productsLoading || products.length === 0}
          />
        </label>

        {titleSupported && <label className="task-center-new-task-title">
          <span>{t('center.newTask.taskTitle')}</span>
          <Input value={taskTitle} onChange={event => setTaskTitle(event.target.value)} placeholder={t('center.newTask.taskTitlePlaceholder')} disabled={starting} aria-label={t('center.newTask.taskTitleAria')}/>
        </label>}

        {workspaceSupported ? <>
          <div className="task-center-launch-modes" role="radiogroup" aria-label={t('center.newTask.launchModeAria')}>
            <Button className="task-center-launch-choice" role="radio" aria-checked={launchMode === 'existing'} onClick={() => selectLaunchMode('existing')}>
              <UiIcon name="folder-open" size={16}/>
              <span><b>{t('center.newTask.existingProject')}</b><small>{t('center.newTask.existingDescription')}</small></span>
            </Button>
            <Button className="task-center-launch-choice" role="radio" aria-checked={launchMode === 'directory'} onClick={() => selectLaunchMode('directory')}>
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
                  placeholder={options.length ? t('center.newTask.selectProject') : projectLoading ? t('center.newTask.loadingProjects') : t('center.newTask.noProject')}
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
                  <Button variant="primary" loading={starting} disabled={!selectedProject || !available} onClick={() => selectedProject && void start(selectedProject.cwd, selectedProject.label)}>{t('center.newTask.openExisting')} <UiIcon name="arrow-right" size={14}/></Button>
                </div>
              </section>
            : <section className="task-center-launch-panel" aria-label={t('center.newTask.newProject')}>
                <div className="task-center-new-manual-directory">
                  <label className="task-center-directory-field">
                    <span>{t('center.newTask.workingDirectory')}</span>
                    <Input
                      value={manualDirectory}
                      onChange={event => { setManualDirectory(event.target.value); setError('') }}
                      placeholder={t('center.newTask.pathPlaceholder')}
                      aria-label={t('center.newTask.pathAria')}
                      aria-invalid={directoryIsInvalid || currentDirectoryCheck?.valid === false || undefined}
                      disabled={starting || selectingDirectory}
                      autoComplete="off"
                      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) void startManualDirectory() }}
                    />
                  </label>
                  {nativeDirectoryPicker && <Button loading={selectingDirectory} disabled={starting} onClick={() => void selectDirectory()}><UiIcon name="folder-open" size={14}/> {t('center.newTask.selectDirectory')}</Button>}
                </div>
                {directoryIsInvalid || currentDirectoryCheck?.valid === false
                  ? <p className="task-center-directory-error" role="alert">{directoryIsInvalid ? t('center.newTask.directoryInvalid') : currentDirectoryCheck?.error}</p>
                  : directoryIsVerified
                    ? <p className="task-center-directory-valid" role="status">{t('center.newTask.directoryReady')}</p>
                    : <p className="task-center-new-directory-hint" role={directoryPath ? 'status' : undefined}>{directoryPath ? t('center.newTask.directoryChecking') : t('center.newTask.pathHint')}</p>}
                {recentDirectories.length > 0 && <div className="task-center-recent-directories">
                  <span>{t('center.newTask.recentDirectories')}</span>
                  <div className="task-center-recent-directory-items">
                    {recentDirectories.map(option => <Button key={option.cwd} size="small" title={option.cwd} onClick={() => { setManualDirectory(option.cwd); setError('') }} disabled={starting || selectingDirectory}>
                      <UiIcon name="folder-open" size={14}/> {basename(option.cwd)}
                    </Button>)}
                  </div>
                </div>}
                <div className="task-center-launch-panel-actions">
                  <Button variant="primary" loading={starting} disabled={!available || selectingDirectory || !directoryIsVerified} onClick={() => void startManualDirectory()}>{t('center.newTask.openPath')} <UiIcon name="arrow-right" size={14}/></Button>
                </div>
              </section>}
        </> : <section className="task-center-direct-start" aria-label={t('center.newTask.startAgent')}>
          <div className="task-center-direct-start-copy">
            <strong>{t('center.newTask.directStartTitle')}</strong>
            <span>{t('center.newTask.directStartDescription', { agent: selectedProduct?.displayName ?? t('center.newTask.agent') })}</span>
          </div>
          <Button variant="primary" loading={starting} disabled={!available} onClick={() => void start(undefined, selectedProduct?.displayName)}>{t('center.newTask.startAgent')} <UiIcon name="arrow-right" size={14}/></Button>
        </section>}
      </div>

      {(error || productsError) && <div className="pi-live-error" role="alert">{error || productsError}</div>}
      {workspaceSupported && projectDiscoveryError && <div className="task-center-project-hint" role="alert">{projectDiscoveryError}</div>}
      {workspaceSupported && !options.length && !projectLoading && !projectDiscoveryError && !projectSearchActive && <div className="task-center-project-hint">{t('center.newTask.noLocalProjects')}</div>}
      {!productsLoading && products.length === 0 && !productsError && <div className="task-center-project-hint">{t('center.newTask.noLiveAgents')}</div>}
    </section>
  </div>
}
