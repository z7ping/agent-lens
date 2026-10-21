import { useEffect, useRef, useState } from 'react'
import type {
  LiveContributionTextDto,
  LiveContributionValueDto,
  LiveRuntimeActionContributionDto,
  LiveRuntimeDisclosureContributionDto,
  LiveRuntimeContributionSectionDto,
} from '@agent-lens/protocol'
import { copyText } from '../client/clipboard'
import { translateProduct } from '../i18n/runtime'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { Button, Dialog, UiIcon } from './ui'

export function contributionText(value: LiveContributionTextDto, language: string): string {
  const normalized = language.replace(/_/g, '-').toLowerCase()
  const localized = Object.entries(value.localizations ?? {})
    .find(([locale]) => locale.toLowerCase() === normalized)?.[1]
  return localized || value.default
}

function contributionValue(value: LiveContributionValueDto, language: string): string {
  return typeof value === 'string' ? value : contributionText(value, language)
}

function runtimeText(key: string): string {
  return translateProduct(`task:center.runtimeDisclosure.${key}`)
}

function duration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const ms = Math.max(0, value)
  if (ms < 1) return '<1ms'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function actionVariant(action: LiveRuntimeActionContributionDto): 'default' | 'primary' | 'danger' {
  return action.tone === 'primary' || action.tone === 'danger' ? action.tone : 'default'
}

interface PreparedField {
  key: string
  id: string
  label: string
  kind: 'text' | 'list' | 'code'
  section?: LiveRuntimeContributionSectionDto | undefined
  values: string[]
}

function prepareFields(item: LiveRuntimeDisclosureContributionDto, language: string): PreparedField[] {
  return item.fields.flatMap((field, index) => {
    const values = [
      ...(field.value !== undefined ? [field.value] : []),
      ...(field.values ?? []),
    ].map(value => contributionValue(value, language))
    if (!values.length) return []
    return [{
      key: `${item.contributionId}:${field.fieldId ?? field.label.default}:${index}`,
      id: field.fieldId ?? '',
      section: field.section,
      label: contributionText(field.label, language),
      kind: field.kind ?? (values.length > 1 ? 'list' : 'text'),
      values,
    }]
  })
}

function fieldSection(field: PreparedField): LiveRuntimeContributionSectionDto {
  // Missing sections from third-party/older plugins fall back to readable defaults.
  // Presentation must never infer semantic meaning from localized labels.
  switch (field.section) {
    case 'status':
    case 'performance':
    case 'resources':
    case 'advanced':
      return field.section
    default:
      // Older/third-party plugins may send an unknown section at runtime.
      // Keep their fields visible rather than silently dropping diagnostics.
      return field.kind === 'code' ? 'advanced' : 'status'
  }
}

export function LiveRuntimeActions({
  item,
  language,
  pendingAction,
  onAction,
}: {
  item: LiveRuntimeDisclosureContributionDto
  language: string
  pendingAction: string | null
  onAction(action: LiveRuntimeActionContributionDto): void
}) {
  if (!item.actions?.length) return null
  return <>
    {item.actions.filter(action => action.placement !== 'composer').map(action => <Button
      key={action.actionId}
      size="small"
      variant={actionVariant(action)}
      disabled={pendingAction !== null}
      title={action.description ? contributionText(action.description, language) : undefined}
      onClick={() => onAction(action)}
    >
      {contributionText(action.label, language)}
    </Button>)}
  </>
}

type CopyState = 'idle' | 'copied' | 'error'

function CopyAction({
  value,
  language,
  labelKey,
}: {
  value: string
  language: string
  labelKey: string
}) {
  const [state, setState] = useState<CopyState>('idle')
  const resetTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  const label = state === 'copied'
    ? runtimeText('copied')
    : state === 'error'
      ? runtimeText('copyFailed')
      : runtimeText(labelKey)

  const copy = async () => {
    window.clearTimeout(resetTimer.current)
    try {
      await copyText(value)
      setState('copied')
    } catch {
      setState('error')
    }
    resetTimer.current = window.setTimeout(() => setState('idle'), 1800)
  }

  return <Button size="small" onClick={() => void copy()}>
    <UiIcon name={state === 'copied' ? 'check' : 'copy'} size={14}/>
    {label}
  </Button>
}

function RuntimeLifecycle({
  item,
  language,
  pendingAction,
  onAction,
  onDiagnostics,
}: {
  item: LiveRuntimeDisclosureContributionDto
  language: string
  pendingAction: string | null
  onAction(action: LiveRuntimeActionContributionDto): void
  onDiagnostics(): void
}) {
  const lifecycle = item.lifecycle
  const activeStage = lifecycle?.stages.find(stage => stage.status === 'active')
  const [expanded, setExpanded] = useState(lifecycle?.status !== 'ready')
  const [clock, setClock] = useState(() => Date.now())
  const timingBaseline = useRef({
    elapsedMs: lifecycle?.elapsedMs ?? 0,
    activeStageId: activeStage?.stageId,
    activeDurationMs: activeStage?.durationMs ?? 0,
    at: Date.now(),
  })

  useEffect(() => {
    if (!lifecycle) return
    setExpanded(lifecycle.status !== 'ready')
  }, [item.contributionId, lifecycle?.status])

  useEffect(() => {
    const now = Date.now()
    timingBaseline.current = {
      elapsedMs: lifecycle?.elapsedMs ?? 0,
      activeStageId: activeStage?.stageId,
      activeDurationMs: activeStage?.durationMs ?? 0,
      at: now,
    }
    setClock(now)
  }, [
    item.contributionId,
    lifecycle?.status,
    lifecycle?.elapsedMs,
    activeStage?.stageId,
    activeStage?.durationMs,
  ])

  useEffect(() => {
    if (lifecycle?.status !== 'initializing') return
    const timer = window.setInterval(() => setClock(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [item.contributionId, lifecycle?.status])

  if (!lifecycle) {
    return <div className="live-runtime-summary-fallback">
      <span><b>{contributionText(item.title, language)}</b>{item.summary && <small>{contributionText(item.summary, language)}</small>}</span>
      <Button size="small" onClick={onDiagnostics}>{runtimeText('runtimeDiagnostics')}</Button>
    </div>
  }

  const title = contributionText(item.title, language)
  const statusLabel = lifecycle.status === 'ready'
    ? runtimeText('ready')
    : lifecycle.status === 'failed'
      ? runtimeText('startupFailed')
      : runtimeText('preparing')
  const resourceSummary = (lifecycle.resources ?? [])
    .map(group => `${contributionText(group.label, language)} ${group.values.length}`)
    .join(' · ')
  const liveDeltaMs = lifecycle.status === 'initializing'
    ? Math.max(0, clock - timingBaseline.current.at)
    : 0
  const elapsedMs = lifecycle.status === 'initializing'
    ? Math.max(lifecycle.elapsedMs ?? 0, timingBaseline.current.elapsedMs + liveDeltaMs)
    : lifecycle.elapsedMs
  const stageDuration = (stage: NonNullable<typeof lifecycle>['stages'][number]) => (
    lifecycle.status === 'initializing'
    && stage.status === 'active'
    && stage.stageId === timingBaseline.current.activeStageId
      ? Math.max(stage.durationMs ?? 0, timingBaseline.current.activeDurationMs + liveDeltaMs)
      : stage.durationMs
  )

  return <details
    className={`live-runtime-disclosure live-runtime-lifecycle is-${lifecycle.status}`}
    open={expanded}
    onToggle={event => setExpanded(event.currentTarget.open)}
  >
    <summary>
      <span className="live-runtime-summary-state" aria-hidden="true"/>
      <span className="live-runtime-summary-copy">
        <b>{title}</b>
        <small>{[statusLabel, resourceSummary].filter(Boolean).join(' · ')}</small>
      </span>
      <span className="live-runtime-summary-time">{duration(elapsedMs)}</span>
      <UiIcon className="live-runtime-chevron" name="chevron-down" size={14}/>
    </summary>

    <div className="live-runtime-body">
      <div className="live-runtime-steps" aria-label={runtimeText('startupStages')}>
        {lifecycle.stages.map(stage => <div
          key={stage.stageId}
          className={`live-runtime-step is-${stage.status}`}
        >
          <span className="live-runtime-step-dot" aria-hidden="true">
            {stage.status === 'done'
              ? <UiIcon name="check" size={12}/>
              : stage.status === 'failed'
                ? <UiIcon name="exclamation" size={12}/>
                : null}
          </span>
          <span className="live-runtime-step-copy"><b>{contributionText(stage.label, language)}</b></span>
          <span className="live-runtime-step-time">
            {stage.status === 'pending'
              ? runtimeText('waiting')
              : stage.status === 'active'
                ? `${duration(stageDuration(stage))}+`
                : duration(stage.durationMs)}
          </span>
        </div>)}
      </div>

      {(lifecycle.resources?.length ?? 0) > 0 && <details className="live-runtime-resource-details">
        <summary>
          {resourceSummary}
          <UiIcon className="live-runtime-resource-chevron" name="chevron-right" size={14}/>
        </summary>
        <div className="live-runtime-resources" aria-label={runtimeText('runtimeResources')}>
          {lifecycle.resources!.map(group => <div className="live-runtime-resource-row" key={group.groupId}>
            <b>[{contributionText(group.label, language)}]</b>
            <span>{group.values.join(', ')}</span>
          </div>)}
        </div>
      </details>}

      {lifecycle.message && lifecycle.status !== 'ready' && <div className="live-runtime-lifecycle-message">
        {contributionText(lifecycle.message, language)}
      </div>}

      <div className="live-runtime-actions live-runtime-lifecycle-actions">
        <Button size="small" onClick={event => { event.preventDefault(); onDiagnostics() }}>
          {runtimeText('runtimeDiagnostics')}
        </Button>
        <LiveRuntimeActions
          item={item}
          language={language}
          pendingAction={pendingAction}
          onAction={onAction}
        />
      </div>
    </div>
  </details>
}

function metricParts(value: string): { label: string; duration?: string } {
  const separator = value.lastIndexOf(' · ')
  return separator > 0
    ? { label: value.slice(0, separator), duration: value.slice(separator + 3) }
    : { label: value }
}

function MetricRows({ values }: { values: readonly string[] }) {
  return <div className="live-runtime-diagnostic-metrics">
    {values.map((value, index) => {
      const metric = metricParts(value)
      return <div className="live-runtime-diagnostic-metric" key={`${index}:${value}`}>
        <span>{metric.label}</span>
        {metric.duration && <b>{metric.duration}</b>}
      </div>
    })}
  </div>
}

function timingCopyText(
  item: LiveRuntimeDisclosureContributionDto,
  language: string,
  fields: readonly PreparedField[],
): string {
  const lifecycle = item.lifecycle
  const startupMetrics = fields.find(field => field.id === 'startup.metrics')
  const lines = [
    runtimeText('startupTiming'),
    '',
    `${runtimeText('totalElapsed')}：${duration(lifecycle?.elapsedMs)}`,
  ]
  if (lifecycle?.stages.length) {
    lines.push('', `【${runtimeText('startupStages')}】`)
    for (const stage of lifecycle.stages) {
      lines.push(`${contributionText(stage.label, language)}：${duration(stage.durationMs)}`)
    }
  }
  if (startupMetrics?.values.length) {
    lines.push('', `【${runtimeText('startupPerformance')}】`, ...startupMetrics.values)
  }
  return lines.join('\n')
}

function diagnosticCopyText(
  item: LiveRuntimeDisclosureContributionDto,
  language: string,
  fields: readonly PreparedField[],
): string {
  const lifecycle = item.lifecycle
  const statusFields = fields.filter(field => fieldSection(field) === 'status' && field.id !== 'runtime.elapsed')
  const performanceFields = fields.filter(field => fieldSection(field) === 'performance')
  const resourceFields = fields.filter(field => fieldSection(field) === 'resources')
  const advancedFields = fields.filter(field => fieldSection(field) === 'advanced')
  const lines = [
    runtimeText('runtimeDiagnostics'),
    '',
    `【${runtimeText('runtimeOverview')}】`,
    ...statusFields.map(field => `${field.label}：${field.values.join(' · ')}`),
  ]

  if (lifecycle) {
    lines.push(`${runtimeText('totalElapsed')}：${duration(lifecycle.elapsedMs)}`)
    lines.push('', `【${runtimeText('startupStages')}】`)
    for (const stage of lifecycle.stages) {
      lines.push(`${contributionText(stage.label, language)}：${duration(stage.durationMs)} · ${stage.status}`)
    }
  }

  if (performanceFields.length) {
    lines.push('', `【${runtimeText('startupPerformance')}】`)
    for (const field of performanceFields) {
      lines.push(`${field.label}：`)
      lines.push(...field.values)
    }
  }

  if (resourceFields.length) {
    lines.push('', `【${runtimeText('runtimeResources')}】`)
    for (const field of resourceFields) {
      lines.push(`${field.label}（${field.values.length}）：${field.values.join(', ')}`)
    }
  }

  if (advancedFields.length) {
    lines.push('', `【${runtimeText('advancedDiagnostics')}】`)
    for (const field of advancedFields) {
      lines.push(`${field.label}：`, ...field.values)
    }
  }
  return lines.join('\n')
}

function RuntimeDiagnostics({
  item,
  language,
}: {
  item: LiveRuntimeDisclosureContributionDto
  language: string
}) {
  const fields = prepareFields(item, language)
  const statusFields = fields.filter(field => fieldSection(field) === 'status' && field.id !== 'runtime.elapsed')
  const performanceFields = fields.filter(field => fieldSection(field) === 'performance')
  const startupMetrics = performanceFields.find(field => field.id === 'startup.metrics')
  const resourceFields = fields.filter(field => fieldSection(field) === 'resources')
  const advancedFields = fields.filter(field => fieldSection(field) === 'advanced')
  const lifecycle = item.lifecycle

  return <div className="live-runtime-diagnostics">
    {(statusFields.length > 0 || lifecycle?.elapsedMs !== undefined) && <section className="live-runtime-diagnostic-section live-runtime-diagnostic-overview">
      <h3>{runtimeText('runtimeOverview')}</h3>
      <div className="live-runtime-diagnostic-overview-grid">
        {lifecycle?.elapsedMs !== undefined && <div className="live-runtime-diagnostic-overview-item is-primary">
          <span>{runtimeText('totalElapsed')}</span>
          <b>{duration(lifecycle.elapsedMs)}</b>
        </div>}
        {statusFields.map(field => <div className="live-runtime-diagnostic-overview-item" key={field.key}>
          <span>{field.label}</span>
          <b title={field.values[0]}>{field.values[0]}</b>
        </div>)}
      </div>
    </section>}

    {(lifecycle?.stages.length || performanceFields.length > 0) && <div className="live-runtime-diagnostic-primary-grid">
      {lifecycle?.stages.length && <section className="live-runtime-diagnostic-section live-runtime-diagnostic-stage-section">
        <h3>{runtimeText('startupStages')}</h3>
        <div className="live-runtime-diagnostic-stages">
          {lifecycle.stages.map(stage => <div className="live-runtime-diagnostic-stage" key={stage.stageId}>
            <span className={`is-${stage.status}`} aria-hidden="true">
              {stage.status === 'done'
                ? <UiIcon name="check" size={12}/>
                : stage.status === 'failed'
                  ? <UiIcon name="exclamation" size={12}/>
                  : null}
            </span>
            <b>{contributionText(stage.label, language)}</b>
            <code>{duration(stage.durationMs)}</code>
          </div>)}
        </div>
      </section>}

      {performanceFields.length > 0 && <section className="live-runtime-diagnostic-section live-runtime-diagnostic-performance">
        <div className="live-runtime-diagnostic-section-head">
          <h3>{runtimeText('startupPerformance')}</h3>
          <CopyAction
            value={startupMetrics ? timingCopyText(item, language, fields) : diagnosticCopyText(item, language, fields)}
            language={language}
            labelKey={startupMetrics ? 'copyTiming' : 'copyDiagnostics'}
          />
        </div>
        {performanceFields.map(field => <div key={field.key}>
          <b>{field.label}</b>
          {field.kind === 'code'
            ? <CopyableCodeBlock copyValue={field.values.join('\n')}>{field.values.join('\n')}</CopyableCodeBlock>
            : <MetricRows values={field.values}/>}
        </div>)}
      </section>}
    </div>}

    {resourceFields.length > 0 && <section className="live-runtime-diagnostic-section live-runtime-diagnostic-resources">
      <h3>{runtimeText('runtimeResources')}</h3>
      <div className="live-runtime-diagnostic-resource-groups">
        {resourceFields.map(field => <section className="live-runtime-diagnostic-resource-group" key={field.key}>
          <header>
            <b>{field.label}</b>
            <span>{field.values.length}</span>
          </header>
          <div className="live-runtime-diagnostic-values">
            {field.values.map((value, index) => <span key={`${field.key}:${index}:${value}`}>{value}</span>)}
          </div>
        </section>)}
      </div>
    </section>}

    {advancedFields.length > 0 && <section className="live-runtime-diagnostic-section live-runtime-diagnostic-advanced">
      <h3>{runtimeText('advancedDiagnostics')}</h3>
      <div className="live-runtime-diagnostic-code-groups">
        {advancedFields.map(field => <section key={field.key}>
          <b>{field.label}</b>
          <CopyableCodeBlock copyValue={field.values.join('\n')}>{field.values.join('\n')}</CopyableCodeBlock>
        </section>)}
      </div>
    </section>}
  </div>
}

function RuntimeDisclosure({
  item,
  language,
  pendingAction,
  onAction,
}: {
  item: LiveRuntimeDisclosureContributionDto
  language: string
  pendingAction: string | null
  onAction(action: LiveRuntimeActionContributionDto): void
}) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const fields = prepareFields(item, language)

  return <>
    <RuntimeLifecycle
      item={item}
      language={language}
      pendingAction={pendingAction}
      onAction={onAction}
      onDiagnostics={() => setDiagnosticsOpen(true)}
    />
    <Dialog
      open={diagnosticsOpen}
      onClose={() => setDiagnosticsOpen(false)}
      size="xlarge"
      className="live-runtime-diagnostics-dialog"
      title={runtimeText('runtimeDiagnostics')}
      headerActions={<CopyAction
        value={diagnosticCopyText(item, language, fields)}
        language={language}
        labelKey="copyDiagnostics"
      />}
    >
      <RuntimeDiagnostics item={item} language={language}/>
    </Dialog>
  </>
}

export function LiveRuntimeDisclosures({
  items,
  language,
  pendingAction,
  onAction,
}: {
  items: readonly LiveRuntimeDisclosureContributionDto[]
  language: string
  pendingAction: string | null
  onAction(action: LiveRuntimeActionContributionDto): void
}) {
  if (!items.length) return null
  return <section className="live-runtime-disclosures">
    {items.map(item => <RuntimeDisclosure
      key={item.contributionId}
      item={item}
      language={language}
      pendingAction={pendingAction}
      onAction={onAction}
    />)}
  </section>
}
