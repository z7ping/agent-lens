import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, UiIcon } from '../components/ui'
import type { LiveTaskProjectionItem } from './live-task-projection'

/** Compact visibility policy: the first three calls plus any running/failed
 * calls stay visible. Hidden calls are still retained in original order.
 */
export function visibleLiveToolIds(
  items: readonly LiveTaskProjectionItem[],
  showAll: boolean,
): Set<string> {
  const tools = items.filter((item): item is Extract<LiveTaskProjectionItem, { kind: 'tool' }> => item.kind === 'tool')
  if (showAll || tools.length <= 5) return new Set(tools.map(item => item.id))
  return new Set(tools.filter((item, index) => index < 3 || item.status === 'running' || item.status === 'error').map(item => item.id))
}

export function LiveToolGroup({
  items,
  renderItem,
}: {
  items: readonly LiveTaskProjectionItem[]
  renderItem: (item: LiveTaskProjectionItem) => ReactNode
}) {
  const { t } = useTranslation('task')
  const [open, setOpen] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const tools = items.filter((item): item is Extract<LiveTaskProjectionItem, { kind: 'tool' }> => item.kind === 'tool')
  const running = tools.filter(item => item.status === 'running').length
  const failed = tools.filter(item => item.status === 'error').length
  const visibleIds = visibleLiveToolIds(items, showAll)
  const hidden = tools.length - visibleIds.size

  return <section className="live-tool-group" data-tool-count={tools.length}>
    <button
      type="button"
      className="live-tool-group-trigger"
      aria-expanded={open}
      onClick={() => setOpen(value => !value)}
    >
      <UiIcon name={open ? 'chevron-down' : 'chevron-right'} size={14}/>
      <UiIcon name="tool-shell" size={14}/>
      <span className="live-tool-group-title">{t('live.toolGroup')}</span>
      <span className="live-tool-group-stats">{t('live.toolGroupCount', { count: tools.length })}{running > 0 ? ` · ${t('live.toolGroupRunning', { count: running })}` : ''}{failed > 0 ? ` · ${t('live.toolGroupFailed', { count: failed })}` : ''}</span>
    </button>
    {open && <div className="live-tool-group-list">
      {items.map(item => item.kind !== 'tool' || visibleIds.has(item.id)
        ? <div key={item.id} className="live-tool-group-item">{renderItem(item)}</div>
        : null)}
      {hidden > 0 && <Button size="small" className="live-tool-group-more" onClick={() => setShowAll(true)}>
        {t('live.toolGroupMore', { count: hidden })}<UiIcon name="chevron-down" size={14}/>
      </Button>}
      {showAll && tools.length > 5 && <Button size="small" className="live-tool-group-more" onClick={() => setShowAll(false)}>
        {t('live.toolGroupLess')}<UiIcon name="arrow-up" size={14}/>
      </Button>}
    </div>}
  </section>
}
