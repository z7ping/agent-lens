import { useEffect, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { ToolKindIcon, toolVisualKind } from '../components/ToolKindIcon'
import { UiIcon } from '../components/UiIcon'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { codeLanguageFromContent } from '../components/code-language'
import { ToolOutputContent } from './ToolOutputContent'
import { Button, Disclosure, StatusBadge } from '../components/ui'
import { isPiSubagentTool, piSubagentResult, piSubagentToolDetails, piSubagentTranscriptMessage } from './task-tool-subagent'
import { PatchDiff } from '@pierre/diffs/react'
import { ImagePreview } from '../components/ImagePreview'
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

/** The official Pi edit tool reports a standard unified patch at details.patch.
 * Do not try to reinterpret its display-only details.diff as unified diff. */
export function taskToolNativePatch(details: unknown): string | undefined {
  const patch = record(details)?.patch
  if (typeof patch !== 'string' || patch.length > 512 * 1024) return undefined
  return /^--- .+$/m.test(patch)
    && /^\+\+\+ .+$/m.test(patch)
    && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(patch)
      ? patch : undefined
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

/** Display a reliable file target as a filename with a subdued directory. */
export function taskToolFilePathParts(value: string): { name: string; directory: string } | undefined {
  const separator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (separator < 0 || separator === value.length - 1) return undefined
  return { name: value.slice(separator + 1), directory: value.slice(0, separator + 1) }
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
  const [rawResultDetails, setRawResultDetails] = useState(false)
  const [subagentVisibleCount, setSubagentVisibleCount] = useState(8)
  const [openSubagents, setOpenSubagents] = useState<Record<number, boolean>>({})
  const [subagentMessageLimits, setSubagentMessageLimits] = useState<Record<number, number>>({})
  const [diffTheme, setDiffTheme] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const nativePatch = expanded ? taskToolNativePatch(model.resultDetails) : undefined
  // An exact native subagent tool name is enough for its identity while running,
  // but mode/count require the official toolResult.details envelope.
  const isSubagentTool = isPiSubagentTool(model.name, model.toolSourceType, model.mcpServerId)
  const verifiedSubagents = isSubagentTool ? piSubagentToolDetails(model.name, model.resultDetails) : undefined
  const nativeSubagents = expanded ? verifiedSubagents : undefined
  const subagentSummary = verifiedSubagents
    ? `${t('tool.subagent.mode.' + verifiedSubagents.mode)} · ${t('tool.subagent.count', { count: verifiedSubagents.results.length })}`
    : undefined
  const visualKind = model.kind === 'tool'
    ? toolVisualKind(model.name, { sourceType: model.toolSourceType, mcpServerId: model.mcpServerId })
    : model.kind
  const target = taskToolTargetText(model, visualKind)
  const hasTarget = Boolean(target)
  const commandParts = visualKind === 'shell' ? taskShellCommandParts(target) : undefined
  const fileTarget = hasTarget && (visualKind === 'read' || visualKind === 'edit')
    ? taskToolFilePathParts(target) : undefined
  const mcpPrefix = model.toolSourceType === 'mcp' && model.mcpServerId
    ? `mcp__${model.mcpServerId}__`
    : undefined
  const mcpToolName = mcpPrefix && model.name.startsWith(mcpPrefix)
    ? model.name.slice(mcpPrefix.length)
    : model.name
  const heading = isSubagentTool ? t('tool.subagent.label')
    : model.toolSourceType === 'mcp' && model.mcpServerId
      ? `${model.mcpServerId} · ${mcpToolName}`
      : model.name
  // A preview is not necessarily the original invocation. Show it as a
  // summary rather than silently relabeling it as complete input parameters.
  const input = model.rawInput
  const preview = !input && hasTarget ? target : undefined
  const commandTarget = visualKind === 'shell' && hasTarget

  useEffect(() => {
    if (!nativePatch) return
    const root = document.documentElement
    const syncTheme = () => setDiffTheme(root.dataset.theme === 'dark' ? 'dark' : 'light')
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [nativePatch])

  useEffect(() => {
    if (model.status !== 'running' || model.startedAtMs === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [model.startedAtMs, model.status])

  const elapsedLabel = model.durationLabel
    ?? (model.durationMs !== undefined ? durationLabel(model.durationMs) : undefined)
    ?? (model.status === 'running' && model.startedAtMs !== undefined ? durationLabel(now - model.startedAtMs) : undefined)
  const status = model.resultMissing ? t('tool.resultMissing') : statusLabel(model.status, t)
  const summaryDetail = subagentSummary ?? (hasTarget ? target : undefined)
  const accessibleHeading = isSubagentTool ? heading : `${t(`tool.kind.${visualKind}`)} · ${heading}`

  return <details
    className={`task-tool-call ${model.status === 'error' ? 'task-tool-row-error ' : ''}${className}`.trim()}
    data-tool-fact="true"
    onToggle={event => setExpanded(event.currentTarget.open)}
    data-status={model.status}
    data-kind={visualKind}
    data-command={commandTarget}
    data-tool-call-id={model.callId}
    data-parent-tool-call-id={model.parentToolCallId}
    data-loaded-child-call-count={model.loadedChildCallCount}
  >
    <summary className="task-tool-row" aria-label={`${accessibleHeading}${summaryDetail ? ` · ${summaryDetail}` : ''}${model.parentToolCallId ? ` · ${t('tool.parentCall')}: ${model.parentToolName ?? model.parentToolCallId}` : ''} · ${status}`}>
      <span className={`task-tool-kind task-tool-kind-${isSubagentTool ? 'subagent' : visualKind}`}>
        <ToolKindIcon kind={isSubagentTool ? 'subagent' : visualKind}/>
      </span>
      <span className="task-tool-summary-text" title={model.parentToolCallId
        ? `${heading} · ${t('tool.parentCall')}: ${model.parentToolName ?? model.parentToolCallId}`
        : heading}>
        {model.parentToolCallId && <UiIcon name="fork" size={12}/>}
        {heading}
      </span>
      <span className="task-tool-preview-slot">
        {subagentSummary
          ? <span className="task-tool-target" title={subagentSummary}>{subagentSummary}</span>
          : commandTarget
          ? <code className="task-tool-command-preview" title={target}>
              {commandParts?.prefix && <span className="task-tool-command-context">{commandParts.prefix}</span>}
              {commandParts?.command ?? target}
            </code>
          : fileTarget
            ? <span className="task-tool-target task-tool-target-file" title={target}>
                <span className="task-tool-file-name">{fileTarget.name}</span>
                <span className="task-tool-file-directory">{fileTarget.directory}</span>
              </span>
            : hasTarget ? <span className="task-tool-target" title={target}>{target}</span> : null}
      </span>
      <span className={`task-tool-status task-tool-status-${statusClass(model.status)}`} title={[status, elapsedLabel].filter(Boolean).join(' · ')}>
        <span className="task-tool-status-mark" aria-hidden="true">
          {model.status === 'running' ? <UiIcon name="loading" size={14}/>
            : model.status === 'success' ? <UiIcon name="check" size={16}/>
              : model.status === 'error' ? <UiIcon name="close" size={16}/>
                : <UiIcon name="clock" size={14}/>}
        </span>
        {(model.status !== 'unknown' || model.resultMissing) && <span className="task-tool-status-label">{status}</span>}
      </span>
      <UiIcon className="task-tool-row-chevron" name="chevron-right" size={14}/>
    </summary>
    {(!compact || expanded) && <div className="task-tool-sections">
      {(model.parentToolCallId || model.loadedChildCallCount) && <section
        className="task-tool-section"
        data-tool-section="ancestry"
        aria-label={t('tool.ancestry')}
      >
        <div className="task-tool-section-title">{t('tool.ancestry')}</div>
        {model.parentToolCallId && <div>
          {t('tool.parentCall')}: <code title={model.parentToolCallId}>
            {model.parentToolName ? `${model.parentToolName} (${model.parentToolCallId})` : model.parentToolCallId}
          </code>
        </div>}
        {model.loadedChildCallCount !== undefined && <div>
          {t('tool.loadedChildCalls', { count: model.loadedChildCallCount })}
        </div>}
      </section>}
      <section className="task-tool-section" data-tool-section="input" aria-label={t('tool.input')}>
        <div className="task-tool-section-title">{input === undefined && preview ? t('tool.inputPreview') : t('tool.input')}</div>
        {input !== undefined
          ? <CopyableCodeBlock copyValue={input} language={expanded ? codeLanguageFromContent(input, visualKind === 'shell' ? (/powershell|pwsh/i.test(model.name) ? 'powershell' : 'bash') : undefined) : undefined}>{input}</CopyableCodeBlock>
          : preview ? <CopyableCodeBlock copyValue={preview} language={expanded ? codeLanguageFromContent(preview, visualKind === 'shell' ? 'bash' : undefined) : undefined}>{preview}</CopyableCodeBlock>
            : <span className="task-tool-section-empty">{t('tool.inputUnavailable')}</span>}
      </section>
      <section className="task-tool-section" data-tool-section="output" aria-label={t('tool.output')}>
        <div className="task-tool-section-title">{t('tool.output')}</div>
        {model.attachments?.length ? <div className="task-message-attachments">
          {model.attachments.map((attachment, index) => attachment.type === 'image'
            ? attachment.dataUrl
              ? <ImagePreview key={index} src={attachment.dataUrl} alt={attachment.name ?? t('message.imageAttachment')}/>
              : <span key={index} className="task-message-attachment-placeholder">
                  {attachment.name ?? t('message.imageAttachment')}
                </span>
            : <span key={index} className="task-message-file-attachment">
                {attachment.name ?? t('message.fileAttachment')}
              </span>)}
        </div> : null}
        {model.output !== undefined
          ? <ToolOutputContent text={model.output} streaming={model.status === 'running'} highlight={expanded}/>
          : !model.attachments?.length
            ? <span className="task-tool-section-empty">{model.resultMissing ? t('tool.resultMissing') : model.status === 'running' ? t('tool.outputPending') : t('tool.outputUnavailable')}</span>
            : null}
      </section>
      {expanded && model.resultDetails !== undefined && <section className="task-tool-section" data-tool-section="details" aria-label={t('tool.resultDetails')}>
        <div className="task-tool-section-title">{t('tool.resultDetails')}</div>
        {(nativePatch || nativeSubagents) && <div className="task-tool-output-format-actions">
          <button type="button" aria-pressed={!rawResultDetails}
            onClick={() => setRawResultDetails(false)}>{t('toolOutput.formatted')}</button>
          <button type="button" aria-pressed={rawResultDetails}
            onClick={() => setRawResultDetails(true)}>{t('toolOutput.original')}</button>
        </div>}
        {nativePatch && !rawResultDetails
          ? <div className="task-file-diff-code">
              <PatchDiff patch={nativePatch} options={{
                diffStyle: 'unified',
                theme: diffTheme === 'dark' ? 'pierre-dark' : 'pierre-light',
                hunkSeparators: 'line-info',
              }}/>
            </div>
          : nativeSubagents && !rawResultDetails
            ? <div className="task-tool-subagent-list" data-subagent-mode={nativeSubagents.mode}>
                <div className="task-tool-subagent-overview">
                  <span>{t('tool.subagent.mode.' + nativeSubagents.mode)}</span>
                  <span>{t('tool.subagent.count', { count: nativeSubagents.results.length })}</span>
                </div>
                {nativeSubagents.results.slice(0, subagentVisibleCount).map((rawResult, index) => {
                  const child = piSubagentResult(rawResult)
                  if (!child) return <div key={index} className="task-tool-section-empty">
                    {t('tool.subagent.unrecognized')}
                  </div>
                  const opened = openSubagents[index] === true
                  const messageLimit = subagentMessageLimits[index] ?? 15
                  const usage = child.usage
                  const usageParts = [
                    ...(usage?.turns !== undefined ? [t('tool.subagent.turns', { count: usage.turns })] : []),
                    ...(usage?.input !== undefined ? [t('tool.subagent.inputTokens', { count: usage.input })] : []),
                    ...(usage?.output !== undefined ? [t('tool.subagent.outputTokens', { count: usage.output })] : []),
                    ...(usage?.cacheRead !== undefined ? [t('tool.subagent.cacheRead', { count: usage.cacheRead })] : []),
                    ...(usage?.cacheWrite !== undefined ? [t('tool.subagent.cacheWrite', { count: usage.cacheWrite })] : []),
                    ...(usage?.cost !== undefined ? [t('tool.subagent.cost', { value: usage.cost })] : []),
                  ]
                  return <Disclosure
                    key={index}
                    open={opened}
                    className="task-tool-subagent-entry"
                    summary={<span className="task-tool-subagent-name">
                      {child.step !== undefined ? t('tool.subagent.step', { step: child.step }) + ' · ' : ''}{child.agent}
                    </span>}
                    summaryMeta={<span className="task-tool-subagent-meta">
                      {child.model && <span>{child.model}</span>}
                      <StatusBadge tone={child.status === 'completed' ? 'success'
                        : child.status === 'failed' ? 'danger'
                          : child.status === 'aborted' ? 'warning'
                            : child.status === 'running' ? 'accent' : 'neutral'}>
                        {t('tool.subagent.status.' + child.status)}
                      </StatusBadge>
                    </span>}
                    onToggle={event => {
                      const open = event.currentTarget.open
                      event.stopPropagation()
                      setOpenSubagents(previous => ({ ...previous, [index]: open }))
                    }}
                  >
                    {opened && <div className="task-tool-subagent-body">
                      {child.task && <div className="task-tool-subagent-fact">
                        <strong>{t('tool.subagent.task')}</strong>
                        <span className="task-tool-subagent-text">{child.task}</span>
                      </div>}
                      {usageParts.length > 0 && <div className="task-tool-subagent-usage">
                        {usageParts.join(' · ')}
                      </div>}
                      {child.errorMessage && <div className="task-tool-subagent-error" role="alert">
                        {child.errorMessage}
                      </div>}
                      <div className="task-tool-subagent-messages">
                        <div className="task-tool-section-title">
                          {t('tool.subagent.messages', { count: child.messages.length })}
                        </div>
                        {child.messages.length === 0 && <span className="task-tool-section-empty">
                          {t('tool.subagent.noMessages')}
                        </span>}
                        {child.messages.slice(0, messageLimit).map((rawMessage, messageIndex) => {
                          const message = piSubagentTranscriptMessage(rawMessage)
                          if (!message) return <div key={messageIndex} className="task-tool-section-empty">
                            {t('tool.subagent.unrecognizedMessage')}
                          </div>
                          return <div key={messageIndex} className="task-tool-subagent-message">
                            <div className="task-tool-subagent-message-role">
                              {t('tool.subagent.role.' + message.role)}
                            </div>
                            {message.parts.map((part, partIndex) => <div
                              key={partIndex} className="task-tool-subagent-message-part"
                            >
                              {part.kind !== 'text' && <span className="task-tool-subagent-message-kind">
                                {t('tool.subagent.part.' + part.kind)}
                              </span>}
                              <ToolOutputContent text={part.text} highlight={false}/>
                              {part.truncated && <span className="task-tool-section-empty">
                                {t('tool.subagent.truncated')}
                              </span>}
                            </div>)}
                            {message.parts.length === 0 && <span className="task-tool-section-empty">
                              {t('tool.subagent.nonText')}
                            </span>}
                            {message.omittedParts > 0 && <span className="task-tool-section-empty">
                              {t('tool.subagent.omittedParts', { count: message.omittedParts })}
                            </span>}
                          </div>
                        })}
                        {child.messages.length > messageLimit && <Button size="small" variant="quiet"
                          onClick={() => setSubagentMessageLimits(previous => ({
                            ...previous, [index]: messageLimit + 15,
                          }))}>
                          {t('tool.subagent.moreMessages', { count: child.messages.length - messageLimit })}
                        </Button>}
                      </div>
                    </div>}
                  </Disclosure>
                })}
                {nativeSubagents.results.length > subagentVisibleCount && <Button
                  size="small" variant="quiet"
                  onClick={() => setSubagentVisibleCount(value => value + 8)}>
                  {t('tool.subagent.moreResults', { count: nativeSubagents.results.length - subagentVisibleCount })}
                </Button>}
              </div>
            : <ToolOutputContent
                text={typeof model.resultDetails === 'string'
                  ? model.resultDetails : JSON.stringify(model.resultDetails, null, 2) ?? String(model.resultDetails)}
                highlight={expanded}
              />}
      </section>}
      {(meta || elapsedLabel || onClick || details) && <div className="task-tool-detail-footer">
        {elapsedLabel && <span>{status} · {elapsedLabel}</span>}
        {meta && <span className="task-tool-meta">{meta}</span>}
        {onClick && <button type="button" className="task-tool-inspect" onClick={onClick}>{t('tool.inspect')}</button>}
        {details}
      </div>}
    </div>}
  </details>
}
