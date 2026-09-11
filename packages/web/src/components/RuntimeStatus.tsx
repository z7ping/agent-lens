import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClientSnapshot } from '../client/model'
import packageMetadata from '../../package.json'
import { projectRuntimeStatus, resolveRuntimeEndpoint } from './runtime-status'
import { UiIcon } from './UiIcon'
import { Popover } from './ui'

function formatStartedAt(value: string | null, locale: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale, { hour12: false })
}

export function RuntimeStatus({ health, liveConnected }: Pick<ClientSnapshot, 'health' | 'liveConnected'>) {
  const { t, i18n } = useTranslation('common')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const [open, setOpen] = useState(false)
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

  const ariaLabel = t('runtimeStatus.aria', { summary: status.summary })

  return <div className="runtime-status">
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
      <UiIcon className="runtime-status-chevron" name="chevron-down" size={12}/>
    </button>
    <Popover open={open} anchorRef={triggerRef} onClose={() => setOpen(false)} placement="right-end" className="runtime-status-popover">
      <section id={detailsId} role="region" aria-label={t('runtimeStatus.detailAria')}>
      <div className="runtime-status-head">
        <div>
          <small>{t('runtimeStatus.currentConnection')}</small>
          <strong>{status.label}</strong>
        </div>
        <span className={`runtime-status-state runtime-status-state-${status.tone}`}>{status.live}</span>
      </div>

      <dl className="runtime-status-grid">
        <div><dt>{t('runtimeStatus.runtimeAddress')}</dt><dd><code>{endpoint.origin}</code></dd></div>
        <div><dt>{t('runtimeStatus.owner')}</dt><dd>{status.owner}</dd></div>
        <div><dt>{t('runtimeStatus.mode')}</dt><dd>{status.mode}</dd></div>
        <div><dt>{t('runtimeStatus.pid')}</dt><dd>{status.pid}</dd></div>
        <div><dt>{t('runtimeStatus.backend')}</dt><dd>{status.backend}</dd></div>
        <div><dt>{t('runtimeStatus.live')}</dt><dd>{status.live}</dd></div>
        <div><dt>{t('runtimeStatus.startedAt')}</dt><dd>{formatStartedAt(status.startedAt, locale)}</dd></div>
      </dl>

      <div className="runtime-status-section">
        <h3>{t('runtimeStatus.compatibilityStorage')}</h3>
        <dl className="runtime-status-grid runtime-status-grid-compact">
          <div><dt>{t('runtimeStatus.webVersion')}</dt><dd>v{packageMetadata.version}</dd></div>
          <div><dt>{t('runtimeStatus.protocolVersion')}</dt><dd>{health?.protocolVersion ?? '—'}</dd></div>
          <div><dt>{t('runtimeStatus.storage')}</dt><dd>{status.storage}</dd></div>
          <div><dt>Schema</dt><dd>{status.schema}</dd></div>
        </dl>
      </div>

      <div className="runtime-status-section">
        <h3>{t('runtimeStatus.dataSources')}</h3>
        <dl className="runtime-status-grid runtime-status-grid-compact">
          <div><dt>{t('runtimeStatus.failedStages')}</dt><dd>{status.failedSourceStages}</dd></div>
          <div><dt>{t('runtimeStatus.unknownEvents')}</dt><dd>{status.unknownTotal}</dd></div>
          {status.coverage && <div className="runtime-status-wide"><dt>{t('runtimeStatus.coverageLabel')}</dt><dd>{status.coverage}</dd></div>}
        </dl>
      </div>
      </section>
    </Popover>
  </div>
}
