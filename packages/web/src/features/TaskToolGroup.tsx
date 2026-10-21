import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, StatusBadge, UiIcon } from '../components/ui'
import type { TaskToolGroupModel, TaskToolModel } from './task-detail-model'
import { TaskToolRow } from './TaskToolRow'

export const TASK_TOOL_PREVIEW_LIMIT = 1

/** Share the same progressive visibility rule across Live and Review. */
export function visibleTaskToolIds(tools: readonly TaskToolModel[], expanded: boolean): Set<string> {
  return new Set(tools.filter((tool, index) =>
    expanded || index < TASK_TOOL_PREVIEW_LIMIT || tool.status === 'running' || tool.status === 'error',
  ).map(tool => tool.id))
}

/** Tool entries and non-tool facts in original semantic order. */
export type TaskToolGroupSequenceEntry =
  | { type: 'tool'; key: string; tool: TaskToolModel; meta?: ReactNode; details?: ReactNode; onToolClick?: () => void }
  | { type: 'content'; key: string; content: ReactNode }

export interface TaskToolGroupProps {
  sequence?: readonly TaskToolGroupSequenceEntry[]
  model: TaskToolGroupModel
  defaultExpanded?: boolean
  /** Shared owner keeps user disclosure intent when virtual rounds unmount. */
  expansionStore?: Map<string, boolean> | undefined
  /** Defer expensive payload rendering until a tool row is opened. */
  compact?: boolean
  renderMeta?: ((tool: TaskToolModel) => ReactNode) | undefined
  renderDetails?: ((tool: TaskToolModel) => ReactNode) | undefined
  onToolClick?: ((tool: TaskToolModel) => void) | undefined
  className?: string
}

export function TaskToolGroup({
  model,
  sequence,
  defaultExpanded = false,
  expansionStore,
  compact = false,
  renderMeta,
  renderDetails,
  onToolClick,
  className = '',
}: TaskToolGroupProps) {
  const { t } = useTranslation('task')
  const [expanded, setExpanded] = useState(() => expansionStore?.get(model.id) ?? defaultExpanded)
  useEffect(() => {
    setExpanded(expansionStore?.get(model.id) ?? defaultExpanded)
  }, [expansionStore, model.id])

  const tools = sequence ? sequence.flatMap(entry => entry.type === 'tool' ? [entry.tool] : []) : model.tools
  const collapsible = tools.some((tool, index) =>
    index >= TASK_TOOL_PREVIEW_LIMIT && tool.status !== 'running' && tool.status !== 'error')
  const visibleIds = visibleTaskToolIds(tools, expanded)
  const hiddenCount = tools.length - visibleIds.size
  const running = tools.filter(tool => tool.status === 'running').length
  const failed = tools.filter(tool => tool.status === 'error').length

  // A single call is never a tool group: show the normal tool row directly.
  if (tools.length === 1) {
    const tool = tools[0]!
    const entry = sequence?.find(item => item.type === 'tool' && item.tool.id === tool.id)
    return <TaskToolRow
      model={tool}
      compact={compact}
      meta={entry?.type === 'tool' ? entry.meta ?? renderMeta?.(tool) : renderMeta?.(tool)}
      details={entry?.type === 'tool' ? entry.details ?? renderDetails?.(tool) : renderDetails?.(tool)}
      onClick={entry?.type === 'tool' ? entry.onToolClick ?? (onToolClick ? () => onToolClick(tool) : undefined) : onToolClick ? () => onToolClick(tool) : undefined}
    />
  }

  return <div
    className={`task-tool-group ${failed ? 'task-tool-group-error' : ''} ${className}`.trim()}
    data-error-count={failed}
    data-task-tool-group="true"
    data-collapsible={collapsible || undefined}
    data-interleaved={sequence ? 'true' : undefined}
    aria-label={t('tool.calls', { count: tools.length })}
  >
    <div className="task-tool-group-header">
      <span className="task-tool-group-heading">
        <UiIcon name="tool-shell" size={14}/>
        <span className="task-tool-group-title">{t('live.toolGroup')}</span>
        <StatusBadge tone="neutral" className="task-tool-group-count">{tools.length}</StatusBadge>
      </span>
      {running > 0 && <span className="task-tool-group-running">{t('live.toolGroupRunning', { count: running })}</span>}
      {failed > 0 && <span className="task-tool-group-failed">{t('live.toolGroupFailed', { count: failed })}</span>}
      {collapsible && <Button
        size="small"
        className="task-tool-group-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => {
          const next = !value
          expansionStore?.set(model.id, next)
          return next
        })}
      >
        <span className="task-tool-group-more">{expanded
          ? t('live.toolGroupLess')
          : t('live.toolGroupMore', { count: hiddenCount })}</span>
        <UiIcon name="chevron-down" className="task-tool-group-chevron" size={14}/>
      </Button>}
    </div>
    <div className="task-tool-list">{(sequence ?? tools.map((tool): TaskToolGroupSequenceEntry => ({
      type: 'tool', key: tool.id, tool,
    }))).map((entry, index) => entry.type === 'content'
      ? <Fragment key={entry.key}>{entry.content}</Fragment>
      : visibleIds.has(entry.tool.id) && <TaskToolRow
        key={entry.key}
        model={entry.tool}
        compact={compact}
        meta={entry.meta ?? renderMeta?.(entry.tool)}
        details={entry.details ?? renderDetails?.(entry.tool)}
        last={index === (sequence?.length ?? tools.length) - 1}
        onClick={entry.onToolClick ?? (onToolClick ? () => onToolClick(entry.tool) : undefined)}
      />)}</div>
  </div>
}

/** Only uninterrupted tool runs share an independent disclosure budget. */
export type TaskProcessSequenceSegment =
  | { type: 'tools'; key: string; entries: Extract<TaskToolGroupSequenceEntry, { type: 'tool' }>[] }
  | { type: 'content'; key: string; content: ReactNode }

export function splitAdjacentTaskToolEntries(sequence: readonly TaskToolGroupSequenceEntry[]): TaskProcessSequenceSegment[] {
  const segments: TaskProcessSequenceSegment[] = []
  for (const entry of sequence) {
    if (entry.type === 'content') {
      segments.push(entry)
      continue
    }
    const previous = segments[segments.length - 1]
    if (previous?.type === 'tools') previous.entries.push(entry)
    else segments.push({ type: 'tools', key: entry.key, entries: [entry] })
  }
  return segments
}

/** Shared Live / Review ordering and progressive tool-group renderer. */
export function TaskProcessSequence({ id, sequence, expansionStore }: {
  id: string
  sequence: readonly TaskToolGroupSequenceEntry[]
  expansionStore?: Map<string, boolean> | undefined
}) {
  const { t } = useTranslation('task')
  return <>{splitAdjacentTaskToolEntries(sequence).map(segment => {
    if (segment.type === 'content') return <Fragment key={segment.key}>{segment.content}</Fragment>
    const tools = segment.entries.map(entry => entry.tool)
    return <TaskToolGroup
      key={segment.key}
      compact
      expansionStore={expansionStore}
      sequence={segment.entries}
      model={{
        id: `tools:${id}:${segment.key}`,
        label: t('live.toolGroup'),
        itemCount: tools.length,
        errorCount: tools.filter(tool => tool.status === 'error').length,
        kindCounts: [],
        tools,
      }}
    />
  })}</>
}
