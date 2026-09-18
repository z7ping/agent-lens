import { useEffect, useState } from 'react'
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

  useEffect(() => {
    setOpen(item.defaultExpanded === true)
  }, [item.contributionId, item.defaultExpanded])

  return <Disclosure
    className={`live-runtime-disclosure is-${item.tone ?? 'neutral'}`}
    open={open}
    onToggle={event => setOpen(event.currentTarget.open)}
    summary={<b>{contributionText(item.title, language)}</b>}
    summaryMeta={item.summary ? contributionText(item.summary, language) : undefined}
  >
    <div className="live-runtime-disclosure-fields">
      {item.fields.map((field, index) => {
        const values = [
          ...(field.value !== undefined ? [field.value] : []),
          ...(field.values ?? []),
        ].map(value => contributionValue(value, language))
        if (!values.length) return null
        const label = contributionText(field.label, language)
        if (field.kind === 'code') {
          const code = values.join('\n')
          return <div className="live-runtime-disclosure-field is-code" key={`${label}:${index}`}>
            <b>{label}</b>
            <CopyableCodeBlock copyValue={code}>{code}</CopyableCodeBlock>
          </div>
        }
        if (field.kind === 'list' || values.length > 1) {
          return <div className="live-runtime-disclosure-field is-list" key={`${label}:${index}`}>
            <b>{label}</b>
            <ul>{values.map((value, valueIndex) => <li key={`${valueIndex}:${value}`}>{value}</li>)}</ul>
          </div>
        }
        return <div className="live-runtime-disclosure-field" key={`${label}:${index}`}>
          <b>{label}</b><span>{values[0]}</span>
        </div>
      })}
    </div>
    {item.actions?.length ? <div className="live-runtime-disclosure-actions">
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
    </div> : null}
  </Disclosure>
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
