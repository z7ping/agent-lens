import type {
  LiveContributionTextDto,
  LiveContributionValueDto,
  LiveRuntimeActionContributionDto,
  LiveRuntimeDisclosureContributionDto,
} from '@agent-lens/protocol'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { Button, Disclosure } from './ui'

function contributionText(value: LiveContributionTextDto, language: string): string {
  const normalized = language.replace(/_/g, '-').toLowerCase()
  const localized = Object.entries(value.localizations ?? {})
    .find(([locale]) => locale.toLowerCase() === normalized)?.[1]
  return localized || value.default
}

function contributionValue(value: LiveContributionValueDto, language: string): string {
  return typeof value === 'string' ? value : contributionText(value, language)
}

function actionVariant(action: LiveRuntimeActionContributionDto): 'default' | 'primary' | 'danger' {
  return action.tone === 'primary' || action.tone === 'danger' ? action.tone : 'default'
}

function localText(language: string, zh: string, en: string): string {
  return language.replace(/_/g, '-').toLowerCase().startsWith('zh') ? zh : en
}

interface PreparedField {
  key: string
  id: string
  label: string
  kind: 'text' | 'list' | 'code'
  values: string[]
}

function prepareFields(
  items: readonly LiveRuntimeDisclosureContributionDto[],
  language: string,
): PreparedField[] {
  return items.flatMap(item => item.fields.flatMap((field, index) => {
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
  }))
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

function RuntimeDisclosureActions({
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
  return <div className="live-runtime-info-actions">
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
  </div>
}

function RuntimeInfoRows({ fields }: { fields: readonly PreparedField[] }) {
  if (!fields.length) return null
  return <div className="live-runtime-info-rows">
    {fields.map(field => <div className="live-runtime-info-row" key={field.key}>
      <span>{field.label}</span>
      <b title={field.values[0]}>{field.values[0]}</b>
    </div>)}
  </div>
}

function metricParts(value: string): { label: string; duration?: string } {
  const separator = value.lastIndexOf(' · ')
  return separator > 0
    ? { label: value.slice(0, separator), duration: value.slice(separator + 3) }
    : { label: value }
}

function RuntimeMetricList({ values }: { values: readonly string[] }) {
  return <div className="live-runtime-info-metrics">
    {values.map((value, index) => {
      const metric = metricParts(value)
      return <div className="live-runtime-info-metric" key={`${index}:${value}`}>
        <span>{metric.label}</span>
        {metric.duration && <b>{metric.duration}</b>}
      </div>
    })}
  </div>
}

function RuntimePerformance({ fields, language }: { fields: readonly PreparedField[]; language: string }) {
  if (!fields.length) return null
  const mainCosts = fields.find(field => field.id === 'Main costs')
  const details = fields.filter(field => field.id !== 'Main costs')
  return <section className="live-runtime-info-section">
    <h3>{localText(language, '启动性能', 'Startup performance')}</h3>
    {mainCosts && <div className="live-runtime-info-subgroup">
      <b className="live-runtime-info-subtitle">{mainCosts.label}</b>
      <RuntimeMetricList values={mainCosts.values}/>
    </div>}
    {details.map(field => <Disclosure
      className="live-runtime-info-disclosure"
      key={field.key}
      summary={<b>{field.label}</b>}
      summaryMeta={String(field.values.length)}
    >
      <RuntimeMetricList values={field.values}/>
    </Disclosure>)}
  </section>
}

function RuntimeResources({ fields, language }: { fields: readonly PreparedField[]; language: string }) {
  if (!fields.length) return null
  return <section className="live-runtime-info-section">
    <h3>{localText(language, '运行资源', 'Runtime resources')}</h3>
    <div className="live-runtime-info-resource-list">
      {fields.map(field => <Disclosure
        className="live-runtime-info-disclosure"
        key={field.key}
        summary={<b>{field.label}</b>}
        summaryMeta={String(field.values.length)}
      >
        <div className="live-runtime-info-values">
          {field.values.map((value, index) => <span key={`${field.key}:${index}:${value}`}>{value}</span>)}
        </div>
      </Disclosure>)}
    </div>
  </section>
}

function RuntimeAdvanced({ fields, language }: { fields: readonly PreparedField[]; language: string }) {
  if (!fields.length) return null
  return <section className="live-runtime-info-section">
    <Disclosure
      className="live-runtime-info-disclosure live-runtime-info-advanced"
      summary={<b>{localText(language, '高级诊断', 'Advanced diagnostics')}</b>}
      summaryMeta={String(fields.length)}
    >
      <div className="live-runtime-info-code-groups">
        {fields.map(field => <section key={field.key}>
          <b>{field.label}</b>
          <CopyableCodeBlock copyValue={field.values.join('\n')}>{field.values.join('\n')}</CopyableCodeBlock>
        </section>)}
      </div>
    </Disclosure>
  </section>
}

export function LiveRuntimeTaskInfo({
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
  const fields = prepareFields(items, language)
  if (!fields.length && !items.some(item => item.actions?.length)) return null
  const statusFields = fields.filter(field => fieldSection(field) === 'status')
  const performanceFields = fields.filter(field => fieldSection(field) === 'performance')
  const resourceFields = fields.filter(field => fieldSection(field) === 'resources')
  const advancedFields = fields.filter(field => fieldSection(field) === 'advanced')

  return <div className="live-runtime-task-info">
    {statusFields.length > 0 && <section className="live-runtime-info-section">
      <h3>{localText(language, '运行状态', 'Runtime status')}</h3>
      <RuntimeInfoRows fields={statusFields}/>
    </section>}
    <RuntimePerformance fields={performanceFields} language={language}/>
    <RuntimeResources fields={resourceFields} language={language}/>
    <RuntimeAdvanced fields={advancedFields} language={language}/>
    {items.map(item => <RuntimeDisclosureActions
      key={`${item.contributionId}:actions`}
      item={item}
      language={language}
      pendingAction={pendingAction}
      onAction={onAction}
    />)}
  </div>
}

export function LiveRuntimeFailureNotice({
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
  const item = items.find(candidate => candidate.tone === 'danger' || candidate.actions?.length)
  if (!item) return null
  const fields = prepareFields([item], language)
  const error = fields.find(field => field.id === 'Runtime error')
    ?? fields.find(field => field.id === 'Extension binding error')
    ?? fields.find(field => field.kind === 'code')

  return <section className="live-runtime-failure-notice" role="alert">
    <div className="live-runtime-failure-copy">
      <b>{localText(language, '运行失败', 'Runtime failed')}</b>
      {error?.values[0]
        ? <span>{error.values[0]}</span>
        : item.summary && <span>{contributionText(item.summary, language)}</span>}
    </div>
    <RuntimeDisclosureActions
      item={item}
      language={language}
      pendingAction={pendingAction}
      onAction={onAction}
    />
  </section>
}
