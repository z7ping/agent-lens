import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PiLiveInitializationStageDto, PiLiveStateDto } from '@agent-lens/protocol'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { OperationProgress } from './StateViews'
import { Button, UiIcon } from './ui'
import { agentLensI18n } from '../i18n/runtime'

const STAGES: Array<{ stage: PiLiveInitializationStageDto; labelKey: string; detailKey: string }> = [
  { stage: 'starting_worker', labelKey: 'startup.stage.startingWorker', detailKey: 'startup.stage.startingWorkerDetail' },
  { stage: 'loading_sdk', labelKey: 'startup.stage.loadingSdk', detailKey: 'startup.stage.loadingSdkDetail' },
  { stage: 'loading_resources', labelKey: 'startup.stage.loadingResources', detailKey: 'startup.stage.loadingResourcesDetail' },
  { stage: 'creating_session', labelKey: 'startup.stage.creatingSession', detailKey: 'startup.stage.creatingSessionDetail' },
  { stage: 'binding_extensions', labelKey: 'startup.stage.bindingExtensions', detailKey: 'startup.stage.bindingExtensionsDetail' },
]

export function formatPiStartupDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const ms = Math.max(0, value)
  if (ms < 1) return '<1ms'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

export function piStartupSummary(state: PiLiveStateDto): { label: string; duration: string } {
  const completedDuration = (state.initializationTimings ?? []).reduce((sum, item) => sum + Math.max(0, item.durationMs), 0)
  const elapsed = state.initializationElapsedMs ?? completedDuration
  return {
    label: state.status === 'failed'
      ? agentLensI18n.t('piLive:startup.failed')
      : state.status === 'ready'
        ? agentLensI18n.t('piLive:startup.ready')
        : agentLensI18n.t('piLive:startup.preparing'),
    duration: formatPiStartupDuration(elapsed),
  }
}

function runtimeModeLabel(state: PiLiveStateDto): string {
  if (state.runtimeMode === 'session_runtime') return 'Session Runtime'
  if (state.runtimeMode === 'compatibility') return agentLensI18n.t('piLive:startup.compatibility')
  return ''
}

export function PiStartupDisclosure({
  state,
  busy,
  fallbackError,
  onRetry,
  onTerminate,
  embedded = false,
  showAllEvents = true,
}: {
  state: PiLiveStateDto
  busy: boolean
  fallbackError?: string
  onRetry(): void
  onTerminate(): void
  embedded?: boolean
  showAllEvents?: boolean
}) {
  const { t } = useTranslation('piLive')
  const [expanded, setExpanded] = useState(state.status !== 'ready')
  const [clock, setClock] = useState(() => Date.now())
  const baseline = useRef({
    stage: state.initializationStage,
    elapsed: state.initializationElapsedMs ?? 0,
    at: Date.now(),
  })

  useEffect(() => {
    baseline.current = {
      stage: state.initializationStage,
      elapsed: state.initializationElapsedMs ?? baseline.current.elapsed,
      at: Date.now(),
    }
    setClock(Date.now())
  }, [state.initializationElapsedMs, state.initializationStage, state.runtimeSessionId])

  useEffect(() => {
    if (state.status === 'ready') setExpanded(false)
    else if (state.status === 'failed') setExpanded(true)
  }, [state.status])

  useEffect(() => {
    if (state.status !== 'initializing') return
    const timer = window.setInterval(() => setClock(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [state.status])

  const timings = useMemo(() => new Map((state.initializationTimings ?? []).map(item => [item.stage, item.durationMs])), [state.initializationTimings])
  const completedDuration = useMemo(() => [...timings.values()].reduce((sum, value) => sum + Math.max(0, value), 0), [timings])
  const elapsed = state.status === 'initializing'
    ? Math.max(state.initializationElapsedMs ?? 0, baseline.current.elapsed + Math.max(0, clock - baseline.current.at))
    : state.initializationElapsedMs ?? completedDuration
  const currentDuration = Math.max(0, elapsed - completedDuration)
  const title = state.status === 'failed' ? t('startup.failed') : state.status === 'ready' ? t('startup.ready') : t('startup.preparing')
  const currentStage = state.initializationStage
  const sdkVersion = state.sdkVersion || state.capabilities?.sdkVersion
  const mode = runtimeModeLabel(state)
  const resources = state.startupResources
  const resourceGroups = [
    { label: t('startup.resource.context'), values: resources?.contexts ?? [] },
    { label: t('startup.resource.skills'), values: resources?.skills ?? [] },
    { label: t('startup.resource.prompts'), values: resources?.prompts ?? [] },
    { label: t('startup.resource.extensions'), values: resources?.extensions ?? [] },
    { label: t('startup.resource.themes'), values: resources?.themes ?? [] },
  ].filter(group => group.values.length)
  const resourceSummary = resourceGroups.map(group => t('startup.resource.summary', { count: group.values.length, label: group.label })).join(' · ')
  const startupOutput = state.startupOutput ?? []

  const body = <div className="pi-startup-body">
    <div className="pi-startup-steps" aria-label={t('startup.stepsAria')}>
      {STAGES.map(item => {
        const recorded = timings.get(item.stage)
        const failed = state.status === 'failed' && currentStage === item.stage
        const active = state.status === 'initializing' && currentStage === item.stage
        const done = recorded !== undefined || state.status === 'ready'
        const status = failed ? 'failed' : active ? 'active' : done ? 'done' : 'pending'
        const duration = recorded ?? ((active || failed) ? currentDuration : undefined)
        return <div key={item.stage} className={`pi-startup-step is-${status}`}>
          <span className="pi-startup-step-dot" aria-hidden="true">{done ? <UiIcon name="check" size={12}/> : failed ? <UiIcon name="exclamation" size={12}/> : null}</span>
          <span className="pi-startup-step-copy"><b>{t(item.labelKey)}</b><small>{t(item.detailKey)}</small></span>
          <span className="pi-startup-step-time">{status === 'pending' ? t('startup.waiting') : active ? `${formatPiStartupDuration(duration)}+` : formatPiStartupDuration(duration)}</span>
        </div>
      })}
    </div>
    {(sdkVersion || mode || state.processId) && <div className="pi-startup-meta">
      {sdkVersion && <span>Pi v{sdkVersion}</span>}
      {mode && <span>{mode}</span>}
      {state.processId && <span>Worker PID {state.processId}</span>}
    </div>}
    {resourceGroups.length > 0 && <details className="pi-startup-resource-details">
      <summary>{resourceSummary}<UiIcon className="pi-startup-resource-chevron" name="chevron-right" size={14}/></summary>
      <div className="pi-startup-resources" aria-label={t('startup.resourcesAria')}>
        {resourceGroups.map(group => <div className="pi-startup-resource-row" key={group.label}>
          <b>[{group.label}]</b><span>{group.values.join(', ')}</span>
        </div>)}
      </div>
    </details>}
    {showAllEvents && startupOutput.length > 0 && <div className="pi-startup-output">
      <b>{t('startup.startupOutput')}</b><CopyableCodeBlock copyValue={startupOutput.join('\n')}>{startupOutput.join('\n')}</CopyableCodeBlock>
    </div>}
    {showAllEvents && (resources?.diagnostics.length ?? 0) > 0 && <div className="pi-startup-diagnostics">
      <b>{t('startup.resourceDiagnostics')}</b>{resources!.diagnostics.map((message, index) => <span key={`${index}-${message}`}>{message}</span>)}
    </div>}
    {state.status === 'failed' && <div className="pi-startup-failure" role="alert">
      <b>{t('startup.stuckAt', { stage: STAGES.find(item => item.stage === currentStage)?.labelKey ? t(STAGES.find(item => item.stage === currentStage)!.labelKey) : state.initializationMessage || t('startup.initializing') })}</b>
      <span>{state.error || fallbackError || t('startup.initializationFailed')}</span>
    </div>}
    <div className="pi-startup-actions">
      {state.status === 'initializing' && <Button size="small" onClick={event => { event.preventDefault(); onTerminate() }} disabled={busy}>{t('startup.cancelStartup')}</Button>}
      {state.status === 'failed' && <><Button size="small" variant="primary" onClick={event => { event.preventDefault(); onRetry() }} disabled={busy}>{t('startup.retry')}</Button><Button size="small" variant="danger" onClick={event => { event.preventDefault(); onTerminate() }} disabled={busy}>{t('startup.terminate')}</Button></>}
    </div>
  </div>

  if (embedded && state.status === 'ready') return <details
    className="pi-startup-disclosure is-ready"
    open={expanded}
    onToggle={event => setExpanded(event.currentTarget.open)}
  >
    <summary>
      <span className="pi-startup-summary-state" aria-hidden="true"/>
      <span className="pi-startup-summary-copy"><b>{t('startup.ready')}</b>{resourceSummary && <small>{resourceSummary}</small>}</span>
      <span className="pi-startup-summary-time">{formatPiStartupDuration(elapsed)}</span>
      <UiIcon className="pi-startup-chevron" name="chevron-down" size={14}/>
    </summary>
    {body}
  </details>

  if (embedded) return <OperationProgress
    title={title}
    description={state.status === 'failed' ? state.error || fallbackError || 'Pi Runtime 未能完成初始化。' : state.initializationMessage || t('startup.loadingDescription')}
    statusLabel={state.status === 'failed' ? t('startup.failedStatus') : t('startup.initializingStatus')}
    elapsedMs={elapsed}
    tone={state.status === 'failed' ? 'danger' : 'accent'}
    active={state.status === 'initializing'}
  ><div className={`pi-startup-inline is-${state.status}`}>{body}</div></OperationProgress>

  return <details
    className={`pi-startup-disclosure is-${state.status}`}
    open={expanded}
    onToggle={event => setExpanded(event.currentTarget.open)}
  >
    <summary>
      <span className="pi-startup-summary-state" aria-hidden="true"/>
      <span className="pi-startup-summary-copy"><b>{title}</b>{state.status !== 'ready' && <small>{state.initializationMessage || t('startup.prepareRuntime')}</small>}</span>
      <span className="pi-startup-summary-time">{formatPiStartupDuration(elapsed)}</span>
      <UiIcon className="pi-startup-chevron" name="chevron-down" size={14}/>
    </summary>
    {body}
  </details>
}
