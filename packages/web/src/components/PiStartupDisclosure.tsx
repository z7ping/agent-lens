import { useEffect, useMemo, useRef, useState } from 'react'
import type { PiLiveInitializationStageDto, PiLiveStateDto } from '@agent-lens/protocol'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { UiIcon } from './UiIcon'
import { Button } from './ui'

const STAGES: Array<{ stage: PiLiveInitializationStageDto; label: string; detail: string }> = [
  { stage: 'starting_worker', label: '启动 Runtime Worker', detail: '创建独立 Pi 运行进程' },
  { stage: 'loading_sdk', label: '加载 Pi SDK', detail: '定位并加载当前安装的官方 SDK' },
  { stage: 'loading_resources', label: '加载资源', detail: '读取配置、扩展与上下文' },
  { stage: 'creating_session', label: '创建 Pi Session', detail: '建立 Agent Session 与运行时服务' },
  { stage: 'binding_extensions', label: '绑定扩展界面', detail: '连接 Extension UI 与交互通道' },
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
    label: state.status === 'failed' ? 'Pi 启动失败' : state.status === 'ready' ? 'Pi 已就绪' : '正在准备 Pi',
    duration: formatPiStartupDuration(elapsed),
  }
}

function runtimeModeLabel(state: PiLiveStateDto): string {
  if (state.runtimeMode === 'session_runtime') return 'Session Runtime'
  if (state.runtimeMode === 'compatibility') return '兼容模式'
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
  const title = state.status === 'failed' ? 'Pi 启动失败' : state.status === 'ready' ? 'Pi 已就绪' : '正在准备 Pi'
  const currentStage = state.initializationStage
  const sdkVersion = state.sdkVersion || state.capabilities?.sdkVersion
  const mode = runtimeModeLabel(state)
  const resources = state.startupResources
  const resourceGroups = [
    { label: 'Context', values: resources?.contexts ?? [] },
    { label: 'Skills', values: resources?.skills ?? [] },
    { label: 'Prompts', values: resources?.prompts ?? [] },
    { label: 'Extensions', values: resources?.extensions ?? [] },
    { label: 'Themes', values: resources?.themes ?? [] },
  ].filter(group => group.values.length)
  const resourceSummary = resourceGroups.map(group => `${group.values.length} ${group.label}`).join(' · ')
  const startupOutput = state.startupOutput ?? []

  const body = <div className="pi-startup-body">
    <div className="pi-startup-steps" aria-label="Pi Runtime 启动步骤">
      {STAGES.map(item => {
        const recorded = timings.get(item.stage)
        const failed = state.status === 'failed' && currentStage === item.stage
        const active = state.status === 'initializing' && currentStage === item.stage
        const done = recorded !== undefined || state.status === 'ready'
        const status = failed ? 'failed' : active ? 'active' : done ? 'done' : 'pending'
        const duration = recorded ?? ((active || failed) ? currentDuration : undefined)
        return <div key={item.stage} className={`pi-startup-step is-${status}`}>
          <span className="pi-startup-step-dot" aria-hidden="true">{done ? <UiIcon name="check" size={10}/> : failed ? <UiIcon name="exclamation" size={10}/> : null}</span>
          <span className="pi-startup-step-copy"><b>{item.label}</b><small>{item.detail}</small></span>
          <span className="pi-startup-step-time">{status === 'pending' ? '等待' : active ? `${formatPiStartupDuration(duration)}+` : formatPiStartupDuration(duration)}</span>
        </div>
      })}
    </div>
    {(sdkVersion || mode || state.processId) && <div className="pi-startup-meta">
      {sdkVersion && <span>Pi v{sdkVersion}</span>}
      {mode && <span>{mode}</span>}
      {state.processId && <span>Worker PID {state.processId}</span>}
    </div>}
    {resourceGroups.length > 0 && <details className="pi-startup-resource-details">
      <summary>{resourceSummary}</summary>
      <div className="pi-startup-resources" aria-label="Pi 已加载资源">
        {resourceGroups.map(group => <div className="pi-startup-resource-row" key={group.label}>
          <b>[{group.label}]</b><span>{group.values.join(', ')}</span>
        </div>)}
      </div>
    </details>}
    {showAllEvents && startupOutput.length > 0 && <div className="pi-startup-output">
      <b>[启动输出]</b><CopyableCodeBlock copyValue={startupOutput.join('\n')}>{startupOutput.join('\n')}</CopyableCodeBlock>
    </div>}
    {showAllEvents && (resources?.diagnostics.length ?? 0) > 0 && <div className="pi-startup-diagnostics">
      <b>[资源诊断]</b>{resources!.diagnostics.map((message, index) => <span key={`${index}-${message}`}>{message}</span>)}
    </div>}
    {state.status === 'failed' && <div className="pi-startup-failure" role="alert">
      <b>卡在：{STAGES.find(item => item.stage === currentStage)?.label || state.initializationMessage || '初始化'}</b>
      <span>{state.error || fallbackError || 'Pi Runtime 未能完成初始化。'}</span>
    </div>}
    <div className="pi-startup-actions">
      {state.status === 'initializing' && <Button size="small" onClick={event => { event.preventDefault(); onTerminate() }} disabled={busy}>取消启动</Button>}
      {state.status === 'failed' && <><Button size="small" variant="primary" onClick={event => { event.preventDefault(); onRetry() }} disabled={busy}>重试</Button><Button size="small" variant="danger" onClick={event => { event.preventDefault(); onTerminate() }} disabled={busy}>结束 Runtime</Button></>}
    </div>
  </div>

  if (embedded) return <div className={`pi-startup-inline is-${state.status}`}>{body}</div>

  return <details
    className={`pi-startup-disclosure is-${state.status}`}
    open={expanded}
    onToggle={event => setExpanded(event.currentTarget.open)}
  >
    <summary>
      <span className="pi-startup-summary-state" aria-hidden="true"/>
      <span className="pi-startup-summary-copy"><b>{title}</b>{state.status !== 'ready' && <small>{state.initializationMessage || '准备 Pi Runtime'}</small>}</span>
      <span className="pi-startup-summary-time">{formatPiStartupDuration(elapsed)}</span>
      <UiIcon className="pi-startup-chevron" name="chevron-down" size={14}/>
    </summary>
    {body}
  </details>
}
