import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { BackupRestorePreviewResponseDto, BackupSnapshotSummaryDto } from '@agent-lens/protocol'
import { agentLabel } from '../components/AgentScope'
import { LocalPathActions } from '../components/LocalPathActions'
import type { AgentLensApi } from '../client/api'
import { BackupRestoreFileInspector } from './BackupRestoreFileInspector'
import { Button, Input, StatusBadge, UiIcon } from '../components/ui'
import {
  buildPreviewTree, filterPreviewTree, previewCount,
  type PreviewFileStatus, type PreviewTreeNode, type PreviewTreeScope,
} from './backup-restore-preview-tree'

const INITIAL_CHILDREN = 80
const CHILDREN_STEP = 80
type StatusFilter = PreviewFileStatus | 'all'

function markedName(label: string, query: string): ReactNode {
  const needle = query.trim().replace(/\\/g, '/').toLocaleLowerCase()
  const index = label.toLocaleLowerCase().indexOf(needle)
  if (!needle || index < 0) return label
  return <>{label.slice(0, index)}<mark>{label.slice(index, index + needle.length)}</mark>{label.slice(index + needle.length)}</>
}

export function BackupRestorePreviewWorkbench({
  api, preview, snapshot, onBack, onOpenPath, onPathError,
}: {
  api: AgentLensApi
  preview: BackupRestorePreviewResponseDto
  snapshot?: BackupSnapshotSummaryDto
  onBack(): void
  onOpenPath(path: string): Promise<unknown>
  onPathError(reason: unknown): void
}) {
  const { t, i18n } = useTranslation('backup')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    preview.items.find(item => item.status === 'modified')?.archivePath
    ?? preview.items.find(item => item.status === 'missing')?.archivePath
    ?? preview.items.find(item => item.status === 'blocked')?.archivePath
    ?? null)
  const selected = preview.items.find(item => item.archivePath === selectedKey) ?? null
  const [scope, setScope] = useState<PreviewTreeScope>('changes')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const [limitById, setLimitById] = useState<Record<string, number>>({})

  const sourceTree = useMemo(() => buildPreviewTree(preview.items), [preview.items])
  const visibleTree = useMemo(
    () => filterPreviewTree(sourceTree, scope, query, status),
    [sourceTree, scope, query, status],
  )
  const matchingCount = visibleTree.reduce((sum, node) => sum + previewCount(node.counts), 0)
  // A single source is already identified in the heading. Show its folders
  // directly instead of forcing users through an extra root disclosure.
  const displayedRoots = visibleTree.length === 1 ? visibleTree[0]!.children : visibleTree
  const changed = preview.blocked + preview.modified + preview.missing
  // Automatic expansion is bounded by the whole visible result, not per-directory.
  // Thousands of small folders must not render thousands of rows at once.
  const autoExpand = (_node: PreviewTreeNode, depth: number) =>
    depth === 0 || ((scope === 'changes' || Boolean(query.trim())) && matchingCount <= 200)
  const isOpen = (node: PreviewTreeNode, depth: number) =>
    !closed.has(node.id) && (opened.has(node.id) || autoExpand(node, depth))

  useEffect(() => {
    setOpened(new Set())
    setClosed(new Set())
    setLimitById({})
  }, [scope, status, query, preview.snapshotId])

  const toggleNode = (node: PreviewTreeNode, depth: number) => {
    if (isOpen(node, depth)) {
      setClosed(previous => new Set(previous).add(node.id))
      setOpened(previous => { const next = new Set(previous); next.delete(node.id); return next })
    } else {
      setClosed(previous => { const next = new Set(previous); next.delete(node.id); return next })
      setOpened(previous => new Set(previous).add(node.id))
    }
  }

  const selectStatus = (next: PreviewFileStatus) => {
    if (status === next) { setStatus('all'); return }
    setStatus(next)
    setScope(next === 'unchanged' ? 'all' : 'changes')
  }

  const statusCounts: Array<{ key: PreviewFileStatus; count: number; tone: 'danger' | 'warning' | 'accent' | 'success' }> = [
    { key: 'blocked', count: preview.blocked, tone: 'danger' },
    { key: 'modified', count: preview.modified, tone: 'warning' },
    { key: 'missing', count: preview.missing, tone: 'accent' },
    { key: 'unchanged', count: preview.unchanged, tone: 'success' },
  ]

  const renderNode = (node: PreviewTreeNode, depth: number): ReactNode => {
    const rowLabel = node.kind === 'source' ? agentLabel(node.sourceId)
      : node.name === '@archive' ? t('preview.archiveGroup')
      : node.name === '@network' ? t('preview.networkGroup') : node.name
    if (node.kind === 'file') {
      const item = node.item!
      return <div key={node.id} className="backup-preview-tree-file" role="treeitem"
        aria-level={depth + 1} title={node.path} data-status={item.status} data-selected={selectedKey === item.archivePath}>
        <button type="button" className="backup-preview-tree-file-name"
          aria-pressed={selectedKey === item.archivePath} onClick={() => setSelectedKey(item.archivePath)}
          title={t('preview.openFile')}>
          <UiIcon name="file" size={14}/>
          <code>{markedName(node.name, query)}</code>
        </button>
        <StatusBadge tone={item.status === 'blocked' ? 'danger' : item.status === 'modified' ? 'warning' : item.status === 'unchanged' ? 'success' : 'accent'}>
          {t(`previewStatus.${item.status}`)}
        </StatusBadge>
        {item.targetPath && <LocalPathActions path={item.targetPath} onOpen={onOpenPath} onError={onPathError}/>}
        {item.reason && <small className="backup-preview-file-reason" title={item.reason}>{item.reason}</small>}
      </div>
    }
    const expanded = isOpen(node, depth)
    const limit = limitById[node.id] ?? INITIAL_CHILDREN
    const remaining = Math.max(0, node.children.length - limit)
    const changes = node.counts.blocked + node.counts.modified + node.counts.missing
    return <div key={node.id} className="backup-preview-tree-folder" role="treeitem" aria-level={depth + 1} aria-expanded={expanded}>
      <button type="button" className="backup-preview-tree-folder-toggle"
        onClick={() => toggleNode(node, depth)} title={node.path || rowLabel}>
        <UiIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={14}/>
        <UiIcon name="folder-open" size={14}/>
        <span className="backup-preview-tree-folder-name">{markedName(rowLabel, query)}</span>
        <span className="backup-preview-tree-folder-count">{t('tree.files', { count: previewCount(node.counts).toLocaleString(locale) })}</span>
        {changes > 0 && <span className="backup-preview-tree-folder-diff">{t('preview.differenceCount', { count: changes.toLocaleString(locale) })}</span>}
      </button>
      {expanded && <div className="backup-preview-tree-children" role="group">
        {node.children.slice(0, limit).map(child => renderNode(child, depth + 1))}
        {remaining > 0 && <Button size="small" variant="quiet"
          className="backup-preview-tree-more"
          onClick={() => setLimitById(previous => ({ ...previous, [node.id]: limit + CHILDREN_STEP }))}>
          {t('preview.showMore', { count: Math.min(remaining, CHILDREN_STEP).toLocaleString(locale), remaining: remaining.toLocaleString(locale) })}
        </Button>}
      </div>}
    </div>
  }

  return <section className="backup-preview-workbench" aria-label={t('preview.title')}>
    <header className="backup-preview-workbench-header">
      <Button size="small" variant="quiet" onClick={onBack}>
        <UiIcon name="arrow-left" size={14}/>{t('preview.back')}
      </Button>
      <div className="backup-preview-workbench-heading">
        <h2>{t('preview.title')}</h2>
        <span title={preview.snapshotId}>
          {sourceTree.length === 1 ? `${agentLabel(sourceTree[0]!.sourceId)} · ` : ''}
          {snapshot ? new Date(snapshot.createdAt).toLocaleString(locale) : preview.snapshotId}
        </span>
      </div>
      <StatusBadge tone={preview.blocked ? 'warning' : 'success'}>
        {preview.blocked ? t('preview.blocked', { count: preview.blocked }) : t('preview.passed')}
      </StatusBadge>
    </header>

    <div className="backup-preview-workbench-summary">
      <div className="backup-preview-summary-title">
        <UiIcon name={changed > 0 ? 'alert' : 'status-success'} size={20}/>
        <div><strong>{changed ? t('preview.changesFound', { count: changed.toLocaleString(locale) }) : t('preview.noDifferences')}</strong>
          <small>{t('preview.totalChecked', { count: preview.items.length.toLocaleString(locale) })}</small></div>
      </div>
      <div className="backup-preview-workbench-counts" aria-label={t('preview.summary')}>
        {statusCounts.map(item => <Button key={item.key} size="small"
          variant={status === item.key ? 'primary' : 'quiet'} aria-pressed={status === item.key}
          className="backup-preview-status-filter"
          onClick={() => selectStatus(item.key)}>
          <strong>{item.count.toLocaleString(locale)}</strong>
          <span>{t(`previewStatus.${item.key}`)}</span>
        </Button>)}
      </div>
    </div>

    <div className="backup-preview-workbench-tools">
      <div className="backup-preview-scope" role="group" aria-label={t('preview.scopeLabel')}>
        <Button size="small" variant={scope === 'changes' ? 'primary' : 'quiet'}
          aria-pressed={scope === 'changes'} onClick={() => { setScope('changes'); setStatus('all') }}>
          {t('preview.onlyDifferences', { count: changed.toLocaleString(locale) })}
        </Button>
        <Button size="small" variant={scope === 'all' ? 'primary' : 'quiet'}
          aria-pressed={scope === 'all'} onClick={() => { setScope('all'); setStatus('all') }}>
          {t('preview.allFiles', { count: preview.items.length.toLocaleString(locale) })}
        </Button>
      </div>
      <Input value={query} onChange={event => setQuery(event.target.value)} maxLength={256}
        aria-label={t('preview.searchPlaceholder')} placeholder={t('preview.searchPlaceholder')}/>
    </div>

    <div className="backup-preview-browser">
      <section className="backup-preview-browser-tree" aria-label={t('preview.files')}>
        {visibleTree.length ? <div className="backup-preview-tree" role="tree" aria-label={t('preview.files')}>
          <div className="backup-preview-tree-result">{t('preview.matching', { count: matchingCount.toLocaleString(locale) })}</div>
          {displayedRoots.map(root => renderNode(root, 0))}
        </div> : <div className="backup-preview-tree-empty" role="status">
          <UiIcon name={query.trim() ? 'search' : 'status-success'} size={20}/>
          <strong>{query.trim() ? t('preview.noMatches') : changed === 0 && scope === 'changes' ? t('preview.noDifferences') : t('preview.noMatches')}</strong>
          {!query.trim() && scope === 'changes' && <Button size="small" onClick={() => { setScope('all'); setStatus('all') }}>{t('preview.viewAll')}</Button>}
        </div>}
      </section>
      <BackupRestoreFileInspector api={api} snapshotId={preview.snapshotId} item={selected}
        onOpenPath={onOpenPath} onPathError={onPathError}/>
    </div>
    <p className="backup-preview-workbench-note">{t('preview.noteTitle')} {t('preview.noteDescription')} {t('preview.notRestoreReady')}</p>
  </section>
}
