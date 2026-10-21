import { useRef, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiveModelControlDto, LiveThinkingControlDto } from '@agent-lens/protocol'
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
  sessionActions?: readonly ComposerSessionAction[] | undefined
  modelControl?: LiveModelControlDto | null
  thinking?: LiveThinkingControlDto | null
  /** Advertised in Review but unavailable until native Runtime resumes. No invented options. */
  pendingModelControl?: boolean
  pendingThinkingControl?: boolean
  controlsBusy?: boolean
  controlsReady?: boolean
  onModelChange?(value: string): void
  onThinkingChange?(value: string): void
  showStreamingModes?: boolean
  streamingMode?: 'steer' | 'follow-up'
  modesDisabled?: boolean
  onStreamingModeChange?(value: 'steer' | 'follow-up'): void
}

export function TaskSessionComposer({
  editorRef,
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
  sessionActions = [],
  modelControl,
  thinking,
  pendingModelControl = false,
  pendingThinkingControl = false,
  controlsBusy = false,
  controlsReady = false,
  onModelChange,
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
  return <div className={`task-composer ${expanded ? 'is-expanded' : ''}`}>
    <div className="task-composer-editor">
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
            ...(option.description ? { description: option.description } : {}),
          })) ?? []}
          onChange={value => onModelChange?.(value)}
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
      <IconButton variant="primary" className="task-composer-send" disabled={!editorProps.canSubmit || !hasContent} onClick={onSendClick} aria-label={t('live.send')}>
        <UiIcon name="send" size={20}/>
      </IconButton>
    </div>
  </div>
}
