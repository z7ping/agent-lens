import { useEffect, useId, useRef, useState } from 'react'
import type { ClientSnapshot } from '../client/model'
import packageMetadata from '../../package.json'
import { projectRuntimeStatus, resolveRuntimeEndpoint } from './runtime-status'

function formatStartedAt(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export function RuntimeStatus({ health, liveConnected }: Pick<ClientSnapshot, 'health' | 'liveConnected'>) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const detailsId = useId()
  const endpoint = resolveRuntimeEndpoint({
    isDevelopment: import.meta.env.DEV,
    developmentPort: __AGENT_LENS_RUNTIME_PORT__,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    port: window.location.port,
  })
  const status = projectRuntimeStatus(health, liveConnected, endpoint)

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const ariaLabel = `${status.summary}，点击查看连接详情`

  return <div className="runtime-status" ref={wrapperRef}>
    <button
      ref={triggerRef}
      type="button"
      className={`status-pill runtime-status-trigger ${status.tone === 'healthy' ? 'status-pill-online' : status.tone === 'warning' ? 'status-pill-warn' : ''}`}
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-controls={detailsId}
      onClick={() => setOpen(current => !current)}
    >
      <span className={`live-dot ${status.tone === 'healthy' ? 'live-dot-online' : 'live-dot-waiting'}`} aria-hidden="true" />
      <span className="runtime-status-summary">{status.summary}</span>
      <svg className="runtime-status-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>
    </button>
    {open && <section id={detailsId} className="runtime-status-popover" role="region" aria-label="Runtime 连接详情">
      <div className="runtime-status-head">
        <div>
          <small>当前连接</small>
          <strong>{status.label}</strong>
        </div>
        <span className={`runtime-status-state runtime-status-state-${status.tone}`}>{status.live}</span>
      </div>

      <dl className="runtime-status-grid">
        <div><dt>Runtime 地址</dt><dd><code>{endpoint.origin}</code></dd></div>
        <div><dt>运行归属</dt><dd>{status.owner}</dd></div>
        <div><dt>运行方式</dt><dd>{status.mode}</dd></div>
        <div><dt>进程 PID</dt><dd>{status.pid}</dd></div>
        <div><dt>后台服务</dt><dd>{status.backend}</dd></div>
        <div><dt>实时通道</dt><dd>{status.live}</dd></div>
        <div><dt>启动时间</dt><dd>{formatStartedAt(status.startedAt)}</dd></div>
      </dl>

      <div className="runtime-status-section">
        <h3>兼容与存储</h3>
        <dl className="runtime-status-grid runtime-status-grid-compact">
          <div><dt>Web 版本</dt><dd>v{packageMetadata.version}</dd></div>
          <div><dt>协议版本</dt><dd>{health?.protocolVersion ?? '—'}</dd></div>
          <div><dt>存储状态</dt><dd>{status.storage}</dd></div>
          <div><dt>Schema</dt><dd>{status.schema}</dd></div>
        </dl>
      </div>

      <div className="runtime-status-section">
        <h3>数据来源</h3>
        <dl className="runtime-status-grid runtime-status-grid-compact">
          <div><dt>异常阶段</dt><dd>{status.failedSourceStages}</dd></div>
          <div><dt>待适配事件</dt><dd>{status.unknownTotal}</dd></div>
          {status.coverage && <div className="runtime-status-wide"><dt>覆盖范围</dt><dd>{status.coverage}</dd></div>}
        </dl>
      </div>
    </section>}
  </div>
}
