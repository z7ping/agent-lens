import { useEffect, useMemo, useState } from 'react'
import type {
  LiveContributionTextDto,
  LiveContributionValueDto,
  LiveRuntimeActionContributionDto,
  LiveRuntimeDisclosureContributionDto,
} from '@agent-lens/protocol'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { Button, Dialog, Disclosure } from './ui'

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
      key: `${field.label.default}:${index}`,
      label: contributionText(field.label, language),
      kind: field.kind ?? (values.length > 1 ? 'list' : 'text'),
      values,
    }]
  })
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
  return <div className="live-runtime-disclosure-actions">
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
  const [open, setOpen] = useState(item.defaultExpanded === true)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const fields = useMemo(() => prepareFields(item, language), [item, language])
  const compactFields = fields.filter(field => field.kind === 'text' && field.values.length === 1)
  const detailedFields = fields.filter(field => field.kind !== 'text' || field.values.length > 1)
  const alertPreview = (item.tone === 'danger' || item.tone === 'warning')
    ? detailedFields.find(field => field.kind === 'code')?.values[0]
    : undefined

  useEffect(() => {
    setOpen(item.defaultExpanded === true)
    setDetailsOpen(false)
  }, [item.contributionId, item.defaultExpanded])

  const title = contributionText(item.title, language)
  const summary = item.summary ? contributionText(item.summary, language) : undefined

  return <>
    <Disclosure
      className={`live-runtime-disclosure is-${item.tone ?? 'neutral'}`}
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
      summary={<b>{title}</b>}
      summaryMeta={summary}
    >
      <div className="live-runtime-disclosure-compact">
        {compactFields.length > 0 && <div className="live-runtime-disclosure-kv" aria-label={localText(language, '运行信息', 'Runtime information')}>
          {compactFields.map(field => <span className="live-runtime-disclosure-kv-item" key={field.key}>
            <b>{field.label}</b>
            <span title={field.values[0]}>{field.values[0]}</span>
          </span>)}
        </div>}

        {detailedFields.length > 0 && <div className="live-runtime-disclosure-counts" aria-label={localText(language, '诊断明细计数', 'Diagnostic detail counts')}>
          {detailedFields.map(field => <span key={field.key}>
            <b>{field.label}</b>
            <span>{field.values.length}</span>
          </span>)}
        </div>}

        {alertPreview && <div className={`live-runtime-disclosure-alert is-${item.tone}`} title={alertPreview}>
          {alertPreview}
        </div>}

        <div className="live-runtime-disclosure-footer">
          {fields.length > 0 && <Button size="small" onClick={() => setDetailsOpen(true)}>
            {localText(language, '查看完整诊断', 'View full diagnostics')}
          </Button>}
          <RuntimeDisclosureActions
            item={item}
            language={language}
            pendingAction={pendingAction}
            onAction={onAction}
          />
        </div>
      </div>
    </Disclosure>

    <Dialog
      open={detailsOpen}
      onClose={() => setDetailsOpen(false)}
      size="xlarge"
      className="live-runtime-detail-overlay"
      title={title}
      description={summary}
    >
      {compactFields.length > 0 && <section className="live-runtime-detail-overview" aria-label={localText(language, '运行信息', 'Runtime information')}>
        {compactFields.map(field => <div className="live-runtime-detail-overview-item" key={field.key}>
          <b>{field.label}</b>
          <span title={field.values[0]}>{field.values[0]}</span>
        </div>)}
      </section>}

      {detailedFields.length > 0 && <div className="live-runtime-detail-groups">
        {detailedFields.map(field => <section className={`live-runtime-detail-group is-${field.kind}`} key={field.key}>
          <header>
            <b>{field.label}</b>
            <span>{field.values.length}</span>
          </header>
          {field.kind === 'code'
            ? <CopyableCodeBlock copyValue={field.values.join('\n')}>{field.values.join('\n')}</CopyableCodeBlock>
            : <div className="live-runtime-detail-values">
                {field.values.map((value, valueIndex) => <span title={value} key={`${field.key}:${valueIndex}:${value}`}>{value}</span>)}
              </div>}
        </section>)}
      </div>}
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
