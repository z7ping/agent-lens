import { useEffect, useRef, useState } from 'react'
import type {
  LiveContributionTextDto,
  LiveContributionValueDto,
  LiveRuntimeActionContributionDto,
  LiveRuntimeDisclosureContributionDto,
} from '@agent-lens/protocol'
import { copyText } from '../client/clipboard'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { Button, Dialog, UiIcon } from './ui'

function contributionText(value: LiveContributionTextDto, language: string): string {
  const normalized = language.replace(/_/g, '-').toLowerCase()
  const localized = Object.entries(value.localizations ?? {})
    .find(([locale]) => locale.toLowerCase() === normalized)?.[1]
  return localized || value.default
}

function contributionValue(value: LiveContributionValueDto, language: string): string {
  return typeof value === 'string' ? value : contributionText(value, language)
}

function localText(language: string, zh: string, en: string): string {
  return language.replace(/_/g, '-').toLowerCase().startsWith('zh') ? zh : en
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
      key: `${item.contributionId}:${field.label.default}:${index}`,
      id: field.label.default,
      label: contributionText(field.label, language),
      kind: field.kind ?? (values.length > 1 ? 'list' : 'text'),
      values,
    }]
  })
}

function fieldSection(field: PreparedField): 'status' | 'performance' | 'resources' | 'advanced' {
  if (field.kind === 'code') return 'advanced'
  if (field.id === 'Main costs' || field.id === 'Initialization stages' || field.id === 'Startup metrics') {
    return 'performance'
  }
  if (
    field.id === 'Contexts'
    || field.id === 'Skills'
    || field.id === 'Prompts'
    || field.id === 'Themes'
    || field.id === 'Package updates'
    || (field.id === 'Extensions' && field.kind === 'list')
  ) return 'resources'
  return 'status'
}

function RuntimeActions({
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
    {item.actions.map(action => <Button
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
  labelZh,
  labelEn,
}: {
  value: string
  language: string
  labelZh: string
  labelEn: string
}) {
  const [state, setState] = useState<CopyState>('idle')
  const resetTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  const label = state === 'copied'
    ? localText(language, '已复制', 'Copied')
    : state === 'error'
      ? localText(language, '复制失败', 'Copy failed')
      : localText(language, labelZh, labelEn)

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
  const [expanded, setExpanded] = useState(lifecycle?.status !== 'ready')

  useEffect(() => {
    if (!lifecycle) return
    setExpanded(lifecycle.status !== 'ready')
  }, [item.contributionId, lifecycle?.status])

  if (!lifecycle) {
    return <div className="live-runtime-summary-fallback">
      <span><b>{contributionText(item.title, language)}</b>{item.summary && <small>{contributionText(item.summary, language)}</small>}</span>
      <Button size="small" onClick={onDiagnostics}>{localText(language, '运行诊断', 'Runtime diagnostics')}</Button>
    </div>
  }

  const title = contributionText(item.title, language)
  const statusLabel = lifecycle.status === 'ready'
    ? localText(language, '已就绪', 'Ready')
    : lifecycle.status === 'failed'
      ? localText(language, '启动失败', 'Failed')
      : localText(language, '正在准备', 'Preparing')
  const resourceSummary = (lifecycle.resources ?? [])
    .map(group => `${contributionText(group.label, language)} ${group.values.length}`)
    .join(' · ')

  return <details
    className={`pi-startup-disclosure live-runtime-lifecycle is-${lifecycle.status}`}
    open={expanded}
    onToggle={event => setExpanded(event.currentTarget.open)}
  >
    <summary>
      <span className="pi-startup-summary-state" aria-hidden="true"/>
      <span className="pi-startup-summary-copy">
        <b>{title}</b>
        <small>{[statusLabel, resourceSummary].filter(Boolean).join(' · ')}</small>
      </span>
      <span className="pi-startup-summary-time">{duration(lifecycle.elapsedMs)}</span>
      <UiIcon className="pi-startup-chevron" name="chevron-down" size={14}/>
    </summary>

    <div className="pi-startup-body">
      <div className="pi-startup-steps" aria-label={localText(language, '运行时启动阶段', 'Runtime startup stages')}>
        {lifecycle.stages.map(stage => <div
          key={stage.stageId}
          className={`pi-startup-step is-${stage.status}`}
        >
          <span className="pi-startup-step-dot" aria-hidden="true">
            {stage.status === 'done'
              ? <UiIcon name="check" size={12}/>
              : stage.status === 'failed'
                ? <UiIcon name="exclamation" size={12}/>
                : null}
          </span>
          <span className="pi-startup-step-copy"><b>{contributionText(stage.label, language)}</b></span>
          <span className="pi-startup-step-time">
            {stage.status === 'pending'
              ? localText(language, '等待', 'Waiting')
              : stage.status === 'active'
                ? `${duration(stage.durationMs)}+`
                : duration(stage.durationMs)}
          </span>
        </div>)}
      </div>

      {(lifecycle.resources?.length ?? 0) > 0 && <details className="pi-startup-resource-details">
        <summary>
          {resourceSummary}
          <UiIcon className="pi-startup-resource-chevron" name="chevron-right" size={14}/>
        </summary>
        <div className="pi-startup-resources" aria-label={localText(language, '运行资源', 'Runtime resources')}>
          {lifecycle.resources!.map(group => <div className="pi-startup-resource-row" key={group.groupId}>
            <b>[{contributionText(group.label, language)}]</b>
            <span>{group.values.join(', ')}</span>
          </div>)}
        </div>
      </details>}

      {lifecycle.message && lifecycle.status !== 'ready' && <div className="live-runtime-lifecycle-message">
        {contributionText(lifecycle.message, language)}
      </div>}

      <div className="pi-startup-actions live-runtime-lifecycle-actions">
        <Button size="small" onClick={event => { event.preventDefault(); onDiagnostics() }}>
          {localText(language, '运行诊断', 'Runtime diagnostics')}
        </Button>
        <RuntimeActions
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
  const startupMetrics = fields.find(field => field.id === 'Startup metrics')
  const lines = [
    localText(language, 'Runtime 启动耗时', 'Runtime startup timing'),
    '',
    `${localText(language, '总耗时', 'Total elapsed')}：${duration(lifecycle?.elapsedMs)}`,
  ]
  if (lifecycle?.stages.length) {
    lines.push('', `【${localText(language, '启动阶段', 'Startup stages')}】`)
    for (const stage of lifecycle.stages) {
      lines.push(`${contributionText(stage.label, language)}：${duration(stage.durationMs)}`)
    }
  }
  if (startupMetrics?.values.length) {
    lines.push('', `【${localText(language, '启动性能', 'Startup performance')}】`, ...startupMetrics.values)
  }
  return lines.join('\n')
}

function diagnosticCopyText(
  item: LiveRuntimeDisclosureContributionDto,
  language: string,
  fields: readonly PreparedField[],
): string {
  const lifecycle = item.lifecycle
  const statusFields = fields.filter(field => fieldSection(field) === 'status' && field.id !== 'Initialization elapsed')
  const performanceFields = fields.filter(field => field.id === 'Startup metrics')
  const resourceFields = fields.filter(field => fieldSection(field) === 'resources')
  const advancedFields = fields.filter(field => fieldSection(field) === 'advanced')
  const lines = [
    localText(language, 'Runtime 运行诊断', 'Runtime diagnostics'),
    '',
    `【${localText(language, '运行概况', 'Runtime overview')}】`,
    ...statusFields.map(field => `${field.label}：${field.values.join(' · ')}`),
  ]

  if (lifecycle) {
    lines.push(`${localText(language, '总耗时', 'Total elapsed')}：${duration(lifecycle.elapsedMs)}`)
    lines.push('', `【${localText(language, '启动阶段', 'Startup stages')}】`)
    for (const stage of lifecycle.stages) {
      lines.push(`${contributionText(stage.label, language)}：${duration(stage.durationMs)} · ${stage.status}`)
    }
  }

  if (performanceFields.length) {
    lines.push('', `【${localText(language, '启动性能', 'Startup performance')}】`)
    for (const field of performanceFields) {
      lines.push(`${field.label}：`)
      lines.push(...field.values)
    }
  }

  if (resourceFields.length) {
    lines.push('', `【${localText(language, '运行资源', 'Runtime resources')}】`)
    for (const field of resourceFields) {
      lines.push(`${field.label}（${field.values.length}）：${field.values.join(', ')}`)
    }
  }

  if (advancedFields.length) {
    lines.push('', `【${localText(language, '高级诊断', 'Advanced diagnostics')}】`)
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
  const statusFields = fields.filter(field => fieldSection(field) === 'status' && field.id !== 'Initialization elapsed')
  const startupMetrics = fields.find(field => field.id === 'Startup metrics')
  const resourceFields = fields.filter(field => fieldSection(field) === 'resources')
  const advancedFields = fields.filter(field => fieldSection(field) === 'advanced')
  const lifecycle = item.lifecycle

  return <div className="live-runtime-diagnostics">
    {(statusFields.length > 0 || lifecycle?.elapsedMs !== undefined) && <section className="live-runtime-diagnostic-section live-runtime-diagnostic-overview">
      <h3>{localText(language, '运行概况', 'Runtime overview')}</h3>
      <div className="live-runtime-diagnostic-overview-grid">
        {lifecycle?.elapsedMs !== undefined && <div className="live-runtime-diagnostic-overview-item is-primary">
          <span>{localText(language, '总耗时', 'Total elapsed')}</span>
          <b>{duration(lifecycle.elapsedMs)}</b>
        </div>}
        {statusFields.map(field => <div className="live-runtime-diagnostic-overview-item" key={field.key}>
          <span>{field.label}</span>
          <b title={field.values[0]}>{field.values[0]}</b>
        </div>)}
      </div>
    </section>}

    {(lifecycle?.stages.length || startupMetrics) && <div className="live-runtime-diagnostic-primary-grid">
      {lifecycle?.stages.length && <section className="live-runtime-diagnostic-section live-runtime-diagnostic-stage-section">
        <h3>{localText(language, '启动阶段', 'Startup stages')}</h3>
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

      {startupMetrics && <section className="live-runtime-diagnostic-section live-runtime-diagnostic-performance">
        <div className="live-runtime-diagnostic-section-head">
          <h3>{localText(language, '启动性能', 'Startup performance')}</h3>
          <CopyAction
            value={timingCopyText(item, language, fields)}
            language={language}
            labelZh="复制耗时"
            labelEn="Copy timing"
          />
        </div>
        <MetricRows values={startupMetrics.values}/>
      </section>}
    </div>}

    {resourceFields.length > 0 && <section className="live-runtime-diagnostic-section live-runtime-diagnostic-resources">
      <h3>{localText(language, '运行资源', 'Runtime resources')}</h3>
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
      <h3>{localText(language, '高级诊断', 'Advanced diagnostics')}</h3>
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
      title={localText(language, '运行诊断', 'Runtime diagnostics')}
      headerActions={<CopyAction
        value={diagnosticCopyText(item, language, fields)}
        language={language}
        labelZh="复制诊断信息"
        labelEn="Copy diagnostics"
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
