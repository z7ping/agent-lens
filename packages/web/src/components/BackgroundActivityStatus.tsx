import { useEffect, useMemo, useRef, useState } from 'react'
import type { BackgroundActivityItemDto, BackgroundActivityResponseDto, HealthResponseDto } from '@agent-lens/protocol'
import { fetchBackgroundActivity } from '../client/background-activity'
import { agentLabel } from './AgentScope'
import { backgroundActivityLabel, summarizeBackgroundActivity } from './background-activity-presenter'
import { Popover } from './ui'
import './background-activity-status.css'

function formatTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function runtimeOwnerLabel(owner: NonNullable<HealthResponseDto['runtime']>['owner']): string {
  if (owner === 'desktop') return '桌面端'
  if (owner === 'service') return '后台服务'
  if (owner === 'cli') return '命令行'
  return '运行时'
}

function itemLabel(item: BackgroundActivityItemDto, active: boolean): string {
  return backgroundActivityLabel(item, item.sourceId ? agentLabel(item.sourceId) : undefined, active)
}

function recentStateLabel(item: BackgroundActivityItemDto): string {
  if (item.state === 'failed') return '失败'
  if (item.state === 'degraded') return '异常'
  if (item.state === 'paused') return '已暂停'
  return '已完成'
}

export function BackgroundActivityStatus({ health }: { health: HealthResponseDto | null }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [activity, setActivity] = useState<BackgroundActivityResponseDto | null>(null)
  const [loadError, setLoadError] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    let controller: AbortController | undefined

    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
    }
    const schedule = (delay: number) => {
      clearTimer()
      if (!disposed) timer = window.setTimeout(() => { void refresh() }, delay)
    }
    const refresh = async () => {
      if (document.hidden) {
        schedule(10_000)
        return
      }
      controller?.abort()
      controller = new AbortController()
      try {
        const next = await fetchBackgroundActivity(controller.signal)
        if (disposed) return
        setActivity(next)
        setLoadError('')
        schedule(next.active.length ? 2_500 : 8_000)
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return
        setLoadError(error instanceof Error ? error.message : String(error))
        schedule(15_000)
      }
    }
    const onVisibilityChange = () => {
      if (document.hidden) return
      clearTimer()
      void refresh()
    }

    void refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      clearTimer()
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const summary = useMemo(() => {
    const base = summarizeBackgroundActivity(activity)
    const primary = activity?.active[0]
    if (!primary) return base
    const suffix = activity!.active.length > 1 ? ` · 另有 ${activity!.active.length - 1} 项` : ''
    return { ...base, label: `${itemLabel(primary, true)}${suffix}` }
  }, [activity])

  const runtimeText = health?.runtime
    ? `${runtimeOwnerLabel(health.runtime.owner)}进程 PID ${health.runtime.pid}`
    : '运行进程状态暂不可用'
  const runtimeTone = health?.status === 'ok' ? 'ok' : health ? 'degraded' : 'unknown'

  return <div className="workspace-background-activity">
    <button
      ref={anchorRef}
      type="button"
      className={`background-activity-trigger is-${summary.tone}`}
      aria-label={`${summary.label}，查看后台活动`}
      aria-expanded={open}
      title={summary.label}
      onClick={() => setOpen(current => !current)}
    >
      <span className="background-activity-indicator" aria-hidden="true"/>
      <span className="background-activity-trigger-label">{summary.label}</span>
    </button>

    <Popover open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} placement="right-end" className="background-activity-popover">
      <section aria-label="后台活动详情">
        <header className="background-activity-popover-head">
          <div><b>后台活动</b><span>确认 AgentLens 当前是否仍在处理本地数据</span></div>
          <span className={`background-activity-state is-${summary.tone}`}>{activity?.active.length ? `${activity.active.length} 项处理中` : '最近记录'}</span>
        </header>

        <div className={`background-activity-process is-${runtimeTone}`}><span className="background-activity-process-dot" aria-hidden="true"/><span>{runtimeText}</span></div>

        <div className="background-activity-section">
          <div className="background-activity-section-title">正在处理</div>
          {activity?.active.length
            ? <div className="background-activity-list">{activity.active.map(item => <div key={item.id} className="background-activity-item is-active">
                <span className="background-activity-item-mark" aria-hidden="true"/>
                <span className="background-activity-item-copy"><b>{itemLabel(item, true)}</b><small>{item.startedAt ? `开始于 ${formatTime(item.startedAt)}` : item.state === 'pending' ? '等待处理' : '处理中'}</small></span>
              </div>)}</div>
            : <div className="background-activity-empty">当前没有后台数据任务</div>}
        </div>

        <div className="background-activity-section">
          <div className="background-activity-section-title">最近处理</div>
          {activity?.recent.length
            ? <div className="background-activity-list">{activity.recent.map(item => <div key={`${item.id}:${item.updatedAt}`} className={`background-activity-item is-${item.state}`}>
                <span className="background-activity-item-mark" aria-hidden="true"/>
                <span className="background-activity-item-copy"><b>{itemLabel(item, false)}</b><small>{recentStateLabel(item)} · {formatTime(item.completedAt ?? item.updatedAt)}</small>{item.errorSummary && <small className="background-activity-error" title={item.errorSummary}>{item.errorSummary}</small>}</span>
              </div>)}</div>
            : <div className="background-activity-empty">还没有可展示的后台处理记录</div>}
        </div>

        {loadError && <div className="background-activity-load-error">{loadError}，将自动重试。</div>}
      </section>
    </Popover>
  </div>
}
