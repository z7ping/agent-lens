import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiveCacheMetricsDto, LiveContextUsage, LiveModelControlDto, LiveThinkingControlDto } from '@agent-lens/protocol'
import { ComposerPillSelect } from './ComposerPillSelect'
import { LiveMarkdownComposer, type LiveMarkdownComposerHandle, type LiveMarkdownComposerProps } from './LiveMarkdownComposer'
import { Button, IconButton, Popover, UiIcon } from './ui'

/** One composer for Review and Live. Pages own Runtime state/actions, never its markup or CSS. */
export interface ComposerSessionAction {
  id: string
  label: string
  icon?: 'sparkles' | 'collapse' | undefined
  description?: string | undefined
  disabled?: boolean | undefined
  onClick(): void
}

export interface TaskSessionComposerProps extends LiveMarkdownComposerProps {
  editorRef: Ref<LiveMarkdownComposerHandle>
  /** Runtime-owned content placed in the shared composer shell. */
  queueContent?: ReactNode
  expanded: boolean
  onExpandedChange(value: boolean): void
  hasContent: boolean
  onSendClick(): void
  connectionLabel: string
  disconnected?: boolean
  pendingConnection?: boolean
  onSyncSession?(): void
  onReconnectSession?(): void
  connectionBusy?: boolean
  /** Native Runtime capability and activity come from the owning page. */
  interruptAvailable?: boolean
  interruptBusy?: boolean
  onInterrupt?(): void
  responseActivity?: 'waiting' | 'thinking' | 'tools' | 'responding' | 'processing' | null
  sendFeedback?: 'idle' | 'sending' | 'accepted' | 'queued' | 'failed'
  /** Optional Live-only metrics; Review omits this rather than implying a running native session. */
  runtimeMetrics?: { contextUsage?: LiveContextUsage | undefined; cacheMetrics?: LiveCacheMetricsDto | undefined } | undefined
  sessionActions?: readonly ComposerSessionAction[] | undefined
  modelControl?: LiveModelControlDto | null
  thinking?: LiveThinkingControlDto | null
  /** Advertised in Review but unavailable until native Runtime resumes. No invented options. */
  pendingModelControl?: boolean
  pendingThinkingControl?: boolean
  controlsBusy?: boolean
  controlsReady?: boolean
  onModelChange?(value: string): void
  onSetDefaultModel?(): void
  modelMenuOpenRequest?: number
  onThinkingChange?(value: string): void
  showStreamingModes?: boolean
  streamingMode?: 'steer' | 'follow-up'
  modesDisabled?: boolean
  onStreamingModeChange?(value: 'steer' | 'follow-up'): void
}

export function TaskSessionComposer({
  editorRef,
  queueContent,
  expanded,
  onExpandedChange,
  hasContent,
  onSendClick,
  connectionLabel,
  disconnected = false,
  pendingConnection = false,
  onSyncSession,
  onReconnectSession,
  connectionBusy = false,
  interruptAvailable = false,
  interruptBusy = false,
  onInterrupt,
  responseActivity = null,
  sendFeedback = 'idle',
  runtimeMetrics,
  sessionActions = [],
  modelControl,
  thinking,
  pendingModelControl = false,
  pendingThinkingControl = false,
  controlsBusy = false,
  controlsReady = false,
  onModelChange,
  onSetDefaultModel,
  modelMenuOpenRequest,
  onThinkingChange,
  showStreamingModes = false,
  streamingMode = 'steer',
  modesDisabled = false,
  onStreamingModeChange,
  ...editorProps
}: TaskSessionComposerProps) {
  const { t } = useTranslation('task')
  const modelVisible = Boolean(modelControl || pendingModelControl)
  const thinkingVisible = Boolean(thinking || pendingThinkingControl)
  const [connectionMenuOpen, setConnectionMenuOpen] = useState(false)
  const connectionAnchorRef = useRef<HTMLSpanElement>(null)
  const actionAnchorRef = useRef<HTMLSpanElement>(null)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const canManageConnection = Boolean(onSyncSession || onReconnectSession)
  const [metricOpen, setMetricOpen] = useState<'context' | 'cache' | 'compat' | null>(null)
  const contextMetricRef = useRef<HTMLSpanElement>(null)
  const cacheMetricRef = useRef<HTMLSpanElement>(null)
  const compatMetricRef = useRef<HTMLSpanElement>(null)
  const metricCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(metricCloseTimer.current), [])
  const showMetric = (key: 'context' | 'cache' | 'compat') => {
    clearTimeout(metricCloseTimer.current)
    setMetricOpen(key)
  }
  const hideMetricSoon = () => {
    clearTimeout(metricCloseTimer.current)
    metricCloseTimer.current = setTimeout(() => setMetricOpen(null), 160)
  }
  const contextUsage = runtimeMetrics?.contextUsage
  const cacheMetrics = runtimeMetrics?.cacheMetrics
  const cacheLabel = cacheMetrics ? `${cacheMetrics.tokenHitRate.toFixed(1)}%` : '—'
  const compatibilityLabel = !cacheMetrics ? '—'
    : cacheMetrics.compatibility === 'warning' ? t('live.metrics.compatWarning')
    : cacheMetrics.compatibility === 'disabled' ? t('live.metrics.compatDisabled')
    : t('live.metrics.compatOk')
  const tokenCount = contextUsage?.tokens
  const contextLimit = contextUsage?.contextWindow
  const percent = contextUsage?.percent
  const formatCount = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  const contextLabel = contextLimit ? `${percent == null ? '—' : `${percent.toFixed(1)}%`} / ${formatCount(contextLimit)}` : '—'
  const fullCount = (value: number) => new Intl.NumberFormat().format(value)
  return <div className="task-composer-shell">
    <div className={`task-composer ${expanded ? 'is-expanded' : ''}`}>
    {queueContent && <div className="task-composer-queue-slot">{queueContent}</div>}
    <div className={`task-composer-editor${responseActivity || sendFeedback !== 'idle' ? ' has-response-activity' : ''}`}>
      <div className="task-composer-editor-toolbar" aria-label={t('live.composerToolbarAria')}>
        <IconButton
          className="task-composer-editor-action"
          title={expanded ? t('live.composerShrink') : t('live.composerExpand')}
          aria-label={expanded ? t('live.composerShrink') : t('live.composerExpand')}
          onClick={() => onExpandedChange(!expanded)}
        >
          <UiIcon name={expanded ? 'collapse' : 'expand'} size={16}/>
        </IconButton>
      </div>
      <LiveMarkdownComposer {...editorProps} ref={editorRef} inputClassName="task-composer-input"/>
      {(responseActivity || sendFeedback !== 'idle') && <div className="task-composer-response-hint" role="status" aria-live="polite">
        {sendFeedback === 'sending' || (sendFeedback === 'idle' && responseActivity) ? <UiIcon name="loading" size={12}/> : null}
        <span>{sendFeedback !== 'idle' ? t(`live.sendFeedback.${sendFeedback}`) : t(`live.responseActivity.${responseActivity}`)}</span>
        {sendFeedback === 'idle' && interruptAvailable && <span className="task-composer-escape-hint">{t('live.escapeToInterrupt')}</span>}
      </div>}
    </div>
    <div className="task-composer-bar">
      <span ref={connectionAnchorRef} className="task-composer-connection-anchor">
        {canManageConnection ? <Button
          variant="quiet"
          size="small"
          className={`task-composer-runtime task-composer-runtime-action ${disconnected ? 'task-composer-disconnected' : pendingConnection ? 'task-composer-pending' : ''}`.trim()}
          title={connectionLabel}
          aria-label={t('live.connectionMenu')}
          aria-haspopup="menu"
          aria-expanded={connectionMenuOpen}
          onClick={() => setConnectionMenuOpen(value => !value)}
        >
          <span className="task-composer-idle-dot" aria-hidden="true"/>
          <span className="task-composer-runtime-label">{connectionLabel}</span>
          <UiIcon name="chevron-down" size={12}/>
        </Button> : <span className={`task-composer-runtime ${disconnected ? 'task-composer-disconnected' : pendingConnection ? 'task-composer-pending' : ''}`.trim()} title={connectionLabel}>
          <span className="task-composer-idle-dot" aria-hidden="true"/>
          <span className="task-composer-runtime-label">{connectionLabel}</span>
        </span>}
        <Popover open={connectionMenuOpen && canManageConnection} anchorRef={connectionAnchorRef} onClose={() => setConnectionMenuOpen(false)} className="task-composer-menu-popover">
          <div className="task-composer-menu-list" role="menu" aria-label={t('live.connectionMenu')}>
            {onSyncSession && <Button size="small" variant="quiet" role="menuitem" disabled={connectionBusy} onClick={() => { setConnectionMenuOpen(false); onSyncSession() }}>
              <UiIcon name="refresh" size={16}/>{t('live.syncSession')}
            </Button>}
            {onReconnectSession && <Button size="small" variant="quiet" role="menuitem" disabled={connectionBusy} onClick={() => { setConnectionMenuOpen(false); onReconnectSession() }}>
              <UiIcon name="link" size={16}/>{t('live.reconnectSession')}
            </Button>}
          </div>
        </Popover>
      </span>
      <div className="task-composer-settings">
        {modelVisible && <ComposerPillSelect
          control="model"
          ariaLabel={t('live.model')}
          title={modelControl ? t('live.model') : connectionLabel}
          value={modelControl?.value ?? ''}
          placeholder={modelControl?.label || t('live.model')}
          disabled={controlsBusy || !controlsReady || !modelControl}
          options={modelControl?.options.map(option => ({
            value: option.value, label: option.label || option.value,
            ...((option.description || option.value === modelControl.defaultValue) ? {
              description: [option.description, option.value === modelControl.defaultValue ? '全局默认' : '']
                .filter(Boolean).join(' · '),
            } : {}),
          })) ?? []}
          onChange={value => onModelChange?.(value)}
          openRequest={modelMenuOpenRequest}
          footer={onSetDefaultModel && modelControl?.value ? <Button
            size="small"
            variant="quiet"
            disabled={controlsBusy || !controlsReady || modelControl.value === modelControl.defaultValue}
            onClick={onSetDefaultModel}
          >{modelControl.value === modelControl.defaultValue ? '已是全局默认' : '设为全局默认'}</Button> : undefined}
        />}
        {thinkingVisible && <ComposerPillSelect
          control="thinking"
          ariaLabel={t('live.thinking')}
          title={!thinking ? connectionLabel : thinking.options.length <= 1 ? t('live.thinkingNoAlternatives') : t('live.thinking')}
          value={thinking?.value ?? ''}
          placeholder={thinking?.label || t('live.thinking')}
          disabled={controlsBusy || !controlsReady || !thinking || thinking.options.length <= 1}
          options={thinking?.options.map(option => ({
            value: option.value, label: option.label || option.value,
            ...(option.description ? { description: option.description } : {}),
          })) ?? []}
          onChange={value => onThinkingChange?.(value)}
        />}
      </div>
      {showStreamingModes && <div className="task-composer-mode" aria-label={t('live.streamingMode')}>
        <Button size="small" className={`task-composer-mode-action ${streamingMode === 'steer' ? 'active' : ''}`} aria-pressed={streamingMode === 'steer'} disabled={modesDisabled} onClick={() => onStreamingModeChange?.('steer')}>{t('live.steer')}</Button>
        <Button size="small" className={`task-composer-mode-action ${streamingMode === 'follow-up' ? 'active' : ''}`} aria-pressed={streamingMode === 'follow-up'} disabled={modesDisabled} onClick={() => onStreamingModeChange?.('follow-up')}>{t('live.followUp')}</Button>
      </div>}
      {sessionActions.length > 0 && <span ref={actionAnchorRef} className="task-composer-action-anchor">
        <IconButton
          size="small"
          aria-label={t('live.sessionActions')}
          title={t('live.sessionActions')}
          aria-haspopup="menu"
          aria-expanded={actionMenuOpen}
          onClick={() => setActionMenuOpen(value => !value)}
        ><UiIcon name="more" size={16}/></IconButton>
        <Popover open={actionMenuOpen} anchorRef={actionAnchorRef} onClose={() => setActionMenuOpen(false)} className="task-composer-menu-popover">
          <div className="task-composer-menu-list" role="menu" aria-label={t('live.sessionActions')}>
            {sessionActions.map(action => <Button
              key={action.id}
              size="small"
              variant="quiet"
              role="menuitem"
              disabled={action.disabled}
              title={action.description}
              onClick={() => { setActionMenuOpen(false); action.onClick() }}
            ><UiIcon name={action.icon ?? 'refresh'} size={16}/>{action.label}</Button>)}
          </div>
        </Popover>
      </span>}
      {(!interruptAvailable || (hasContent && editorProps.canSubmit)) && <IconButton
        variant={interruptAvailable ? 'default' : 'primary'}
        className="task-composer-send"
        disabled={!editorProps.canSubmit || !hasContent}
        onClick={onSendClick}
        aria-label={t('live.send')}
      ><UiIcon name="send" size={20}/></IconButton>}
      {interruptAvailable && <IconButton
        variant="primary"
        className="task-composer-stop"
        disabled={interruptBusy}
        aria-busy={interruptBusy || undefined}
        onClick={onInterrupt}
        title={t('live.interruptShortcut')}
        aria-label={t('live.stopExecution')}
      ><UiIcon name="stop" size={20}/></IconButton>}
    </div>
    </div>
    {runtimeMetrics && <div className="task-composer-runtime-metrics" aria-label={t('live.metrics.aria')}>
      <span className="task-composer-metric-anchor" ref={contextMetricRef}
        onMouseEnter={() => showMetric('context')} onMouseLeave={hideMetricSoon}>
        <Button size="small" variant="quiet" aria-expanded={metricOpen === 'context'}
          onClick={() => metricOpen === 'context' ? setMetricOpen(null) : showMetric('context')}>
          <UiIcon name="activity" size={12}/>
          <span>{t('live.metrics.context')} {contextLabel}</span>
        </Button>
      </span>
      <Popover open={metricOpen === 'context'} anchorRef={contextMetricRef} placement="bottom-end"
        className="task-composer-menu-popover task-composer-metric-popover" onClose={() => setMetricOpen(null)}>
        <div onMouseEnter={() => showMetric('context')} onMouseLeave={hideMetricSoon}>
          <b>{t('live.metrics.contextDetails')}</b>
          <div>{t('live.metrics.used')}: {tokenCount == null ? t('live.metrics.unknown') : fullCount(tokenCount)}</div>
          <div>{t('live.metrics.window')}: {contextLimit ? fullCount(contextLimit) : t('live.metrics.unknown')}</div>
          <small>{t('live.metrics.contextSource')}</small>
        </div>
      </Popover>
      <span className="task-composer-metric-separator" aria-hidden="true">·</span>
      <span className="task-composer-metric-anchor" ref={cacheMetricRef}
        onMouseEnter={() => showMetric('cache')} onMouseLeave={hideMetricSoon}>
        <Button size="small" variant="quiet" aria-expanded={metricOpen === 'cache'}
          onClick={() => metricOpen === 'cache' ? setMetricOpen(null) : showMetric('cache')}>
          <UiIcon name="database" size={12}/>
          <span>{t('live.metrics.cache')} {cacheLabel}</span>
        </Button>
      </span>
      <Popover open={metricOpen === 'cache'} anchorRef={cacheMetricRef} placement="bottom-end"
        className="task-composer-menu-popover task-composer-metric-popover" onClose={() => setMetricOpen(null)}>
        <div onMouseEnter={() => showMetric('cache')} onMouseLeave={hideMetricSoon}>
          <b>{t('live.metrics.cacheDetails')}</b>
          {cacheMetrics ? <>
            <div>{t('live.metrics.cacheRequests')}: {cacheMetrics.hitRequests}/{cacheMetrics.totalRequests}</div>
            <div>{t('live.metrics.cacheTokens')}: {cacheMetrics.cachedInput}/{cacheMetrics.totalInput}</div>
            <small>{t('live.metrics.cacheNativeSource', { adapter: cacheMetrics.adapter })}</small>
          </> : <><div>{t('live.metrics.cacheUnknown')}</div><small>{t('live.metrics.cacheSource')}</small></>}
        </div>
      </Popover>
      <span className="task-composer-metric-separator" aria-hidden="true">·</span>
      <span className="task-composer-metric-anchor" ref={compatMetricRef}
        onMouseEnter={() => showMetric('compat')} onMouseLeave={hideMetricSoon}>
        <Button size="small" variant="quiet" aria-expanded={metricOpen === 'compat'}
          onClick={() => metricOpen === 'compat' ? setMetricOpen(null) : showMetric('compat')}>
          <UiIcon name="info" size={12}/>
          <span>{t('live.metrics.compat')} {compatibilityLabel}</span>
        </Button>
      </span>
      <Popover open={metricOpen === 'compat'} anchorRef={compatMetricRef} placement="bottom-end"
        className="task-composer-menu-popover task-composer-metric-popover" onClose={() => setMetricOpen(null)}>
        <div onMouseEnter={() => showMetric('compat')} onMouseLeave={hideMetricSoon}>
          <b>{t('live.metrics.compatDetails')}</b>
          <div>{cacheMetrics ? compatibilityLabel : t('live.metrics.compatUnknown')}</div>
          {cacheMetrics?.integrityWarning && <div>{t('live.metrics.integrityWarning')}</div>}
          <small>{cacheMetrics ? t('live.metrics.compatNativeSource') : t('live.metrics.compatSource')}</small>
        </div>
      </Popover>
    </div>}
  </div>
}
