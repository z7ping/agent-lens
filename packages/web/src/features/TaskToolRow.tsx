import { useEffect, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { ToolKindIcon, toolVisualKind } from '../components/ToolKindIcon'
import { UiIcon } from '../components/UiIcon'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { codeLanguageFromContent } from '../components/code-language'
import { ToolOutputContent } from './ToolOutputContent'
import type { TaskToolModel } from './task-detail-model'

export interface TaskToolRowProps {
  model: TaskToolModel
  meta?: ReactNode
  details?: ReactNode
  last?: boolean
  /** Keep the original Inspector action available *inside* the disclosure. */
  onClick?: (() => void) | undefined
  className?: string
}

function statusLabel(status: TaskToolModel['status'], t: TFunction): string {
  if (status === 'error') return t('tool.status.error')
  if (status === 'success') return t('tool.status.success')
  if (status === 'running') return t('tool.status.running')
  return t('tool.status.unknown')
}

function statusClass(status: TaskToolModel['status']): string {
  if (status === 'error') return 'error'
  if (status === 'success') return 'ok'
  if (status === 'running') return 'run'
  return 'unknown'
}

function durationLabel(ms: number): string {
  const value = Math.max(0, ms)
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) {
    const seconds = value / 1000
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  }
  const minutes = value / 60_000
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)}m`
}

export function taskToolTargetText(model: TaskToolModel, visualKind: ReturnType<typeof toolVisualKind>): string {
  const target = model.primary ?? model.secondary ?? '—'
  if (visualKind !== 'shell' || !model.primary || !target.trim().startsWith('{')) return target
  try {
    const input = JSON.parse(target) as unknown
    if (!input || typeof input !== 'object' || Array.isArray(input)) return target
    const record = input as Record<string, unknown>
    for (const key of ['command', 'cmd', 'script', 'raw']) {
      const command = record[key]
      if (typeof command === 'string' && command.trim()) return command.trim()
    }
  } catch {
    return target
  }
  return target
}

/** One native Tool call = one folded row. Arguments and results are not
 * additional disclosures; they are separate named sections inside that row. */
export function TaskToolRow({ model, meta, details, onClick, className = '' }: TaskToolRowProps) {
  const { t } = useTranslation('task')
  const [now, setNow] = useState(() => Date.now())
  // Avoid Prism tokenization across every collapsed tool in long Review/Live sessions.
  const [expanded, setExpanded] = useState(false)
  const visualKind = model.kind === 'tool'
    ? toolVisualKind(model.name, { sourceType: model.toolSourceType, mcpServerId: model.mcpServerId })
    : model.kind
  const target = taskToolTargetText(model, visualKind)
  const hasTarget = target !== '—' && Boolean(target.trim())
  const mcpPrefix = model.toolSourceType === 'mcp' && model.mcpServerId
    ? `mcp__${model.mcpServerId}__`
    : undefined
  const mcpToolName = mcpPrefix && model.name.startsWith(mcpPrefix)
    ? model.name.slice(mcpPrefix.length)
    : model.name
  const heading = visualKind === 'shell' && hasTarget ? target
    : model.toolSourceType === 'mcp' && model.mcpServerId
      ? `${model.mcpServerId} · ${mcpToolName}`
      : model.name
  // A preview is not necessarily the original invocation. Show it as a
  // summary rather than silently relabeling it as complete input parameters.
  const input = model.rawInput
  const preview = !input && hasTarget ? target : undefined
  const commandTarget = visualKind === 'shell' && hasTarget
  const showInputSection = !commandTarget || (input !== undefined && input.trim() !== target.trim())

  useEffect(() => {
    if (model.status !== 'running' || model.startedAtMs === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [model.startedAtMs, model.status])

  const elapsedLabel = model.durationLabel
    ?? (model.durationMs !== undefined ? durationLabel(model.durationMs) : undefined)
    ?? (model.status === 'running' && model.startedAtMs !== undefined ? durationLabel(now - model.startedAtMs) : undefined)
  const status = statusLabel(model.status, t)

  return <details
    className={`task-tool-call ${model.status === 'error' ? 'task-tool-row-error ' : ''}${className}`.trim()}
    data-tool-fact="true"
    onToggle={event => setExpanded(event.currentTarget.open)}
    data-status={model.status}
    data-kind={visualKind}
    data-command={commandTarget}
  >
    <summary className="task-tool-row" aria-label={`${t(`tool.kind.${visualKind}`)} · ${heading} · ${status}`}>
      <span className={`task-tool-kind task-tool-kind-${visualKind}`}>
        <ToolKindIcon kind={visualKind}/>
        <span>{t(`tool.kind.${visualKind}`)}</span>
      </span>
      <span className="task-tool-summary-text" title={commandTarget ? model.name : heading}>{commandTarget ? model.name : heading}</span>
      <span className={`task-tool-status task-tool-status-${statusClass(model.status)}`} title={[status, elapsedLabel].filter(Boolean).join(' · ')}>
        <span className="task-tool-status-mark" aria-hidden="true">
          {model.status === 'running' ? <UiIcon name="loading" size={14}/>
            : model.status === 'success' ? <UiIcon name="check" size={16}/>
              : model.status === 'error' ? <UiIcon name="close" size={16}/>
                : <UiIcon name="clock" size={14}/>}
        </span>
        {model.status !== 'unknown' && <span className="task-tool-status-label">{status}</span>}
      </span>
      <UiIcon className="task-tool-row-chevron" name="chevron-right" size={14}/>
      {commandTarget && <code className="task-tool-command-preview" title={target}>{target}</code>}
    </summary>
    <div className="task-tool-sections">
      {showInputSection && <section className="task-tool-section" data-tool-section="input" aria-label={t('tool.input')}>
        <div className="task-tool-section-title">{input === undefined && preview ? t('tool.inputPreview') : t('tool.input')}</div>
        {input !== undefined
          ? <CopyableCodeBlock copyValue={input} language={expanded ? codeLanguageFromContent(input, visualKind === 'shell' ? (/powershell|pwsh/i.test(model.name) ? 'powershell' : 'bash') : undefined) : undefined}>{input}</CopyableCodeBlock>
          : preview ? <CopyableCodeBlock copyValue={preview} language={expanded ? codeLanguageFromContent(preview, visualKind === 'shell' ? 'bash' : undefined) : undefined}>{preview}</CopyableCodeBlock>
            : <span className="task-tool-section-empty">{t('tool.inputUnavailable')}</span>}
      </section>}
      <section className="task-tool-section" data-tool-section="output" aria-label={t('tool.output')}>
        <div className="task-tool-section-title">{t('tool.output')}</div>
        {model.output !== undefined
          ? <ToolOutputContent text={model.output} streaming={model.status === 'running'} highlight={expanded}/>
          : <span className="task-tool-section-empty">{model.status === 'running' ? t('tool.outputPending') : t('tool.outputUnavailable')}</span>}
      </section>
      {(meta || elapsedLabel || onClick || details) && <div className="task-tool-detail-footer">
        {elapsedLabel && <span>{status} · {elapsedLabel}</span>}
        {meta && <span className="task-tool-meta">{meta}</span>}
        {onClick && <button type="button" className="task-tool-inspect" onClick={onClick}>{t('tool.inspect')}</button>}
        {details}
      </div>}
    </div>
  </details>
}
