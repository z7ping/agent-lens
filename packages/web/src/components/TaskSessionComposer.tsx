import type { Ref } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiveModelControlDto, LiveThinkingControlDto } from '@agent-lens/protocol'
import { ComposerPillSelect } from './ComposerPillSelect'
import { LiveMarkdownComposer, type LiveMarkdownComposerHandle, type LiveMarkdownComposerProps } from './LiveMarkdownComposer'
import { Button, IconButton, UiIcon } from './ui'

/** One composer for Review and Live. Pages own Runtime state/actions, never its markup or CSS. */
export interface TaskSessionComposerProps extends LiveMarkdownComposerProps {
  editorRef: Ref<LiveMarkdownComposerHandle>
  expanded: boolean
  onExpandedChange(value: boolean): void
  hasContent: boolean
  onSendClick(): void
  connectionLabel: string
  disconnected?: boolean
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
  streamingMode?: 'steer' | 'followUp'
  modesDisabled?: boolean
  onStreamingModeChange?(value: 'steer' | 'followUp'): void
}

export function TaskSessionComposer({
  editorRef,
  expanded,
  onExpandedChange,
  hasContent,
  onSendClick,
  connectionLabel,
  disconnected = false,
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
      <span className={`task-composer-runtime ${disconnected ? 'task-composer-disconnected' : ''}`.trim()} title={connectionLabel}>
        <span className="task-composer-idle-dot" aria-hidden="true"/>
        {connectionLabel}
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
        <Button size="small" className={`task-composer-mode-action ${streamingMode === 'followUp' ? 'active' : ''}`} aria-pressed={streamingMode === 'followUp'} disabled={modesDisabled} onClick={() => onStreamingModeChange?.('followUp')}>{t('live.followUp')}</Button>
      </div>}
      <IconButton variant="primary" className="task-composer-send" disabled={!editorProps.canSubmit || !hasContent} onClick={onSendClick} aria-label={t('live.send')}>
        <UiIcon name="send" size={20}/>
      </IconButton>
    </div>
  </div>
}
