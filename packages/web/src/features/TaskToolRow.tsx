import { useEffect, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { ToolKindIcon, toolVisualKind } from '../components/ToolKindIcon'
import { UiIcon } from '../components/UiIcon'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { codeLanguageFromContent } from '../components/code-language'
import { ToolOutputContent } from './ToolOutputContent'
import { reviewToolCommand } from './review-tool-command'
import type { TaskToolModel } from './task-detail-model'

export interface TaskToolRowProps {
  model: TaskToolModel
  meta?: ReactNode
  details?: ReactNode
  last?: boolean
  /** Keep the original Inspector action available *inside* the disclosure. */
  onClick?: (() => void) | undefined
  className?: string
  /** Live renders every invocation as one line until the user opens its details. */
  compact?: boolean
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

/** Only known native input fields become a compact target; never invent one
 * from the tool name, output or opaque JSON. Review/Live/Pi share this rule. */
function parseToolInput(value: string | undefined): unknown {
  const input = value?.trim()
  if (!input) return undefined
  if (!['{', '[', '"'].includes(input[0]!)) return input
  try { return JSON.parse(input) as unknown } catch { return undefined }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

const targetKeys: Record<ReturnType<typeof toolVisualKind>, readonly string[]> = {
  shell: ['command', 'cmd', 'script', 'raw'],
  read: ['path', 'file_path', 'filePath', 'filename', 'file', 'uri'],
  edit: ['path', 'file_path', 'filePath', 'filename', 'new_path', 'old_path'],
  search: ['query', 'pattern', 'search', 'glob', 'keyword', 'keywords', 'regex', 'path'],
  web: ['url', 'href', 'query', 'path'],
  mcp: ['tool', 'server', 'mcp_server', 'method', 'query', 'path'],
  test: ['command', 'cmd', 'script', 'path', 'pattern'],
  tool: ['target', 'resource', 'path', 'query', 'command'],
}

function typedTarget(value: unknown, kind: ReturnType<typeof toolVisualKind>): string {
  const outer = record(value)
  if (!outer) return ''
  const nestedRecord = (value: unknown) => record(
    typeof value === 'string' ? parseToolInput(value) : value,
  )
  const candidates = [outer, nestedRecord(outer.arguments), nestedRecord(outer.args), nestedRecord(outer.input), nestedRecord(outer.parameters)]
  for (const input of candidates) {
    if (!input) continue
    for (const key of targetKeys[kind]) {
      const candidate = input[key]
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
  }
  return ''
}

export function taskToolTargetText(model: TaskToolModel, visualKind: ReturnType<typeof toolVisualKind>): string {
  const payloads = [parseToolInput(model.rawInput), parseToolInput(model.primary)]
  if (visualKind === 'shell') {
    for (const payload of payloads) {
      const command = reviewToolCommand(payload)
      if (command && command.trim().toLowerCase() !== model.name.trim().toLowerCase()) return command
    }
  } else {
    for (const payload of payloads) {
      const target = typedTarget(payload, visualKind)
      if (target && target.toLowerCase() !== model.name.trim().toLowerCase()) return target
    }
  }
  // A plain string preview is useful only when it is distinct from the
  // native name/category. Opaque structured input without a known field is not.
  const preview = model.primary?.trim() ?? ''
  const normalized = preview.toLowerCase()
  if (!preview || preview === '—' || preview === '{}' || preview === '[]'
    || normalized === model.name.trim().toLowerCase()
    || normalized === model.kindLabel.trim().toLowerCase()
    || normalized === visualKind
    || typeof parseToolInput(preview) !== 'string') return ''
  return preview
}

/** Dim only an initial `cd path &&` chain, preserving every original
 * character and leaving quoted paths (including spaces) untouched. */
export function taskShellCommandParts(value: string): { prefix: string; command: string } {
  const start = /^\s*cd(?:\s+\/d)?\s+/i.exec(value)
  if (!start) return { prefix: '', command: value }
  let quote: '"' | "'" | null = null
  for (let i = start[0].length; i < value.length - 1; i += 1) {
    const char = value[i]
    if (char === '"' || char === "'") {
      if (!quote) quote = char
      else if (quote === char) quote = null
    }
    if (!quote && char === '&' && value[i + 1] === '&' && value.slice(i + 2).trim()) {
      return { prefix: value.slice(0, i + 2), command: value.slice(i + 2) }
    }
  }
  return { prefix: '', command: value }
}

/** One native Tool call = one folded row. Arguments and results are not
 * additional disclosures; they are separate named sections inside that row. */
export function TaskToolRow({ model, meta, details, onClick, className = '', compact = false }: TaskToolRowProps) {
  const { t } = useTranslation('task')
  const [now, setNow] = useState(() => Date.now())
  // Avoid Prism tokenization across every collapsed tool in long Review/Live sessions.
  const [expanded, setExpanded] = useState(false)
  const visualKind = model.kind === 'tool'
    ? toolVisualKind(model.name, { sourceType: model.toolSourceType, mcpServerId: model.mcpServerId })
    : model.kind
  const target = taskToolTargetText(model, visualKind)
  const hasTarget = Boolean(target)
  const commandParts = visualKind === 'shell' ? taskShellCommandParts(target) : undefined
  const mcpPrefix = model.toolSourceType === 'mcp' && model.mcpServerId
    ? `mcp__${model.mcpServerId}__`
    : undefined
  const mcpToolName = mcpPrefix && model.name.startsWith(mcpPrefix)
    ? model.name.slice(mcpPrefix.length)
    : model.name
  const heading = model.toolSourceType === 'mcp' && model.mcpServerId
    ? `${model.mcpServerId} · ${mcpToolName}`
    : model.name
  // A preview is not necessarily the original invocation. Show it as a
  // summary rather than silently relabeling it as complete input parameters.
  const input = model.rawInput
  const preview = !input && hasTarget ? target : undefined
  const commandTarget = visualKind === 'shell' && hasTarget

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
    <summary className="task-tool-row" aria-label={`${t(`tool.kind.${visualKind}`)} · ${heading}${hasTarget ? ` · ${target}` : ''} · ${status}`}>
      <span className={`task-tool-kind task-tool-kind-${visualKind}`}>
        <ToolKindIcon kind={visualKind}/>
      </span>
      <span className="task-tool-summary-text" title={heading}>{heading}</span>
      <span className="task-tool-preview-slot">
        {commandTarget
          ? <code className="task-tool-command-preview" title={target}>
              {commandParts?.prefix && <span className="task-tool-command-context">{commandParts.prefix}</span>}
              {commandParts?.command ?? target}
            </code>
          : hasTarget ? <span className="task-tool-target" title={target}>{target}</span> : null}
      </span>
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
    </summary>
    {(!compact || expanded) && <div className="task-tool-sections">
      <section className="task-tool-section" data-tool-section="input" aria-label={t('tool.input')}>
        <div className="task-tool-section-title">{input === undefined && preview ? t('tool.inputPreview') : t('tool.input')}</div>
        {input !== undefined
          ? <CopyableCodeBlock copyValue={input} language={expanded ? codeLanguageFromContent(input, visualKind === 'shell' ? (/powershell|pwsh/i.test(model.name) ? 'powershell' : 'bash') : undefined) : undefined}>{input}</CopyableCodeBlock>
          : preview ? <CopyableCodeBlock copyValue={preview} language={expanded ? codeLanguageFromContent(preview, visualKind === 'shell' ? 'bash' : undefined) : undefined}>{preview}</CopyableCodeBlock>
            : <span className="task-tool-section-empty">{t('tool.inputUnavailable')}</span>}
      </section>
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
    </div>}
  </details>
}
