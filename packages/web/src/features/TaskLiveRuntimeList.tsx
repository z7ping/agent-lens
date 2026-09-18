import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import type { LiveRuntimeRefDto, LiveRuntimeStateDto } from '@agent-lens/protocol'
import { liveApi } from '../client/live'
import { StatusBadge } from '../components/ui'
import { sessionListTitle } from './task-center'
import { workspaceDisplayName } from './task-detail-model'
import {
  parseTaskLiveRuntimeLocation,
  taskLiveRuntimeHref,
  taskLiveRuntimeStatus,
} from './task-live-runtime'

function runtimeTitle(item: LiveRuntimeRefDto, fallback: string): string {
  const workspace = workspaceDisplayName(item.state.workspacePath)
  return item.state.title?.trim() || workspace || fallback
}

function runtimeStatusBadge(
  state: LiveRuntimeStateDto,
  labels: Record<'failed' | 'initializing' | 'terminating' | 'terminated' | 'streaming' | 'idle', string>,
): { label: string; tone: 'accent' | 'warning' | 'danger'; dot?: boolean } {
  const status = taskLiveRuntimeStatus(state)
  if (status === 'failed') return { label: labels.failed, tone: 'danger' }
  if (status === 'initializing') return { label: labels.initializing, tone: 'warning', dot: true }
  if (status === 'terminating') return { label: labels.terminating, tone: 'warning', dot: true }
  if (status === 'terminated') return { label: labels.terminated, tone: 'warning' }
  if (status === 'streaming') return { label: labels.streaming, tone: 'accent', dot: true }
  return { label: labels.idle, tone: 'warning' }
}

export function TaskLiveRuntimeList() {
  const { t } = useTranslation('task')
  const location = useLocation()
  const navigate = useNavigate()
  const [runtimes, setRuntimes] = useState<LiveRuntimeRefDto[]>([])

  const refresh = useCallback(() => {
    void liveApi.knownRuntimes().then(setRuntimes, () => setRuntimes([]))
  }, [])

  useEffect(() => {
    refresh()
    const onVisibility = () => { if (!document.hidden) refresh() }
    const onLiveStateChanged = () => refresh()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('agent-lens:live-state-changed', onLiveStateChanged)
    // Pi compatibility surfaces still emit this event until the migration is complete.
    window.addEventListener('agent-lens:pi-live-state-changed', onLiveStateChanged)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('agent-lens:live-state-changed', onLiveStateChanged)
      window.removeEventListener('agent-lens:pi-live-state-changed', onLiveStateChanged)
    }
  }, [location.pathname, refresh])

  if (!runtimes.length) return null

  const selected = parseTaskLiveRuntimeLocation(location.pathname)
  const labels = {
    failed: t('center.runtimeStatus.failed'),
    initializing: t('center.runtimeStatus.initializing'),
    terminating: t('center.runtimeStatus.terminating'),
    terminated: t('center.runtimeStatus.terminated'),
    streaming: t('center.runtimeStatus.streaming'),
    idle: t('center.runtimeStatus.idle'),
  }

  return <section className="task-center-group task-center-live-group">
    <div className="task-center-group-title"><span>{t('center.history.running')}</span><span>{runtimes.length}</span></div>
    {runtimes.map(item => {
      const fallback = t('center.history.genericAgentTask', { agent: item.displayName })
      const title = runtimeTitle(item, fallback)
      const badge = runtimeStatusBadge(item.state, labels)
      const active = selected?.liveId === item.liveId && selected.runtimeSessionId === item.state.runtimeSessionId
      return <button
        key={`${item.liveId}:${item.state.runtimeSessionId}`}
        className={`session-item task-live-item ${active ? 'session-item-active' : ''}`}
        onClick={() => navigate(taskLiveRuntimeHref(item))}
      >
        <div className="session-item-title-row">
          <div className="session-item-title" title={title}>{sessionListTitle(title, fallback, [item.productId])}</div>
          <StatusBadge tone={badge.tone} dot={badge.dot}>{badge.label}</StatusBadge>
        </div>
        <div className="session-item-meta">
          <span className={item.state.isStreaming || item.state.status === 'initializing' ? 'pi-live-pulse' : 'pi-live-idle-dot'}/>
          <span>{item.displayName}</span>
          <span className="session-item-project">{workspaceDisplayName(item.state.workspacePath) || t('center.history.unlinkedProject')}</span>
        </div>
      </button>
    })}
  </section>
}
