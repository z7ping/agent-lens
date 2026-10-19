import { useEffect, useState } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import type { TaskFileChangeDto, TaskFileChangesResponseDto, TaskFileDiffResponseDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { AgentLensApi } from '../client/api'
import { copyText } from '../client/clipboard'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { LocalResourceReference } from '../components/LocalResourceReference'
import { Button, Disclosure, Drawer, UiIcon } from '../components/ui'

const api = new AgentLensApi()
const INITIAL_VISIBLE_FILES = 3

function absoluteFilePath(rootPath: string | undefined, path: string): string | undefined {
  if (!rootPath) return undefined
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) return path
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const relative = path.replace(/\\/g, '/').replace(/^\/+/, '')
  return `${root}/${relative}`
}

/** Observation is not equivalent to a verified Git change classification. */
function isObservedOnly(change: TaskFileChangeDto): boolean {
  return change.confidence !== 'exact' || change.changeType === 'unknown'
}

function fileNameAndDirectory(path: string): { name: string; directory: string } {
  const normalized = path.replace(/\\/g, '/')
  const separator = normalized.lastIndexOf('/')
  return separator === -1
    ? { name: normalized, directory: '' }
    : { name: normalized.slice(separator + 1), directory: normalized.slice(0, separator + 1) }
}

function localObservationTime(value: string): string {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString(undefined, { hour12: false })
}

function statusCode(change: TaskFileChangeDto): string {
  if (change.changeType === 'added') return 'A'
  if (change.changeType === 'modified') return 'M'
  if (change.changeType === 'deleted') return 'D'
  if (change.changeType === 'renamed') return 'R'
  return ''
}

export function TaskFileChangesDisclosure({
  value,
  loading = false,
  error = '',
  inlineDetails = false,
}: {
  value: TaskFileChangesResponseDto | null
  loading?: boolean
  error?: string
  /** Reuse a parent's task-info Drawer without opening a second Drawer. */
  inlineDetails?: boolean
}) {
  const { t } = useTranslation('review')
  const [showAll, setShowAll] = useState(false)
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [diff, setDiff] = useState<TaskFileDiffResponseDto | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState(false)
  const [evidenceItem, setEvidenceItem] = useState<TaskFileChangeDto | null>(null)
  const [diffLayout, setDiffLayout] = useState<'unified' | 'split'>('unified')
  const [diffTheme, setDiffTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  )
  const [diffCopyState, setDiffCopyState] = useState<'idle' | 'copied' | 'error'>('idle')

  useEffect(() => {
    if (!diffPath) return
    const root = document.documentElement
    const syncTheme = () => setDiffTheme(root.dataset.theme === 'dark' ? 'dark' : 'light')
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [diffPath])

  useEffect(() => { setDiffCopyState('idle') }, [diffPath, diff?.diff])

  const copyDiff = async () => {
    if (!diff?.diff) return
    try {
      await copyText(diff.diff)
      setDiffCopyState('copied')
    } catch {
      setDiffCopyState('error')
    }
  }
  const sessionId = value?.logicalSessionId
  const isInteraction = Boolean(value?.interactionId)

  useEffect(() => {
    if (!diffPath || !sessionId || isInteraction) return
    const controller = new AbortController()
    void api.reviewFileDiff(sessionId, diffPath, controller.signal)
      .then(result => { if (!controller.signal.aborted) setDiff(result) })
      .catch(() => { if (!controller.signal.aborted) setDiffError(true) })
      .finally(() => { if (!controller.signal.aborted) setDiffLoading(false) })
    return () => controller.abort()
  }, [diffPath, sessionId, isInteraction])

  if (!value && !loading && !error) return null
  if (value && value.summary.count === 0 && !value.meta.truncated && !loading && !error) return null

  const count = value?.summary.count ?? 0
  const items = value?.items ?? []
  const displayed = inlineDetails || showAll ? items : items.slice(0, INITIAL_VISIBLE_FILES)
  const hidden = items.length - displayed.length
  const hasExactDelta = value?.summary.additions !== undefined || value?.summary.deletions !== undefined
  const hasUnverifiedFiles = Boolean(value?.interactionId || value?.summary.observedCount || items.some(isObservedOnly))
  const isObserved = Boolean(value?.interactionId)
  const selected = Boolean(evidenceItem || diffPath)
  const inspectingInline = inlineDetails && selected
  const inspectedFilePath = evidenceItem?.path ?? diffPath ?? ''
  const inspectedFile = fileNameAndDirectory(inspectedFilePath)
  const evidenceContent = evidenceItem && <div className="task-file-change-evidence">
    <div className="task-file-change-verdict" role="status">
      <UiIcon name="info" size={16}/>
      <strong>{t('local.fileChanges.observedVerdict')}</strong>
    </div>
    <p className="task-file-change-explanation">{t(isObserved ? 'local.fileChanges.observationDisclaimer' : 'local.fileChanges.sessionObservationDisclaimer')}</p>
    <dl className="task-file-change-facts">
      <div>
        <dt>{t('local.fileChanges.evidenceType')}</dt>
        <dd>{evidenceItem.evidence.map(kind => t(`local.fileChanges.evidenceKinds.${kind}`)).join(' · ') || t('local.fileChanges.notRecorded')}</dd>
      </div>
      <div>
        <dt>{t('local.fileChanges.observedAction')}</dt>
        <dd>{t(`local.fileChanges.status.${evidenceItem.changeType}`)}</dd>
      </div>
      <div>
        <dt>{evidenceItem.firstChangedAt === evidenceItem.lastChangedAt ? t('local.fileChanges.observedAt') : t('local.fileChanges.firstObserved')}</dt>
        <dd><time dateTime={evidenceItem.firstChangedAt} title={evidenceItem.firstChangedAt}>{localObservationTime(evidenceItem.firstChangedAt)}</time></dd>
      </div>
      {evidenceItem.firstChangedAt !== evidenceItem.lastChangedAt && <div>
        <dt>{t('local.fileChanges.lastObserved')}</dt>
        <dd><time dateTime={evidenceItem.lastChangedAt} title={evidenceItem.lastChangedAt}>{localObservationTime(evidenceItem.lastChangedAt)}</time></dd>
      </div>}
    </dl>
    <Disclosure className="task-file-change-raw" summary={t('local.fileChanges.rawEvidence')}>
      <dl>
        <div><dt>{t('local.fileChanges.evidenceType')}</dt><dd>{evidenceItem.evidence.join(', ') || t('local.fileChanges.notRecorded')}</dd></div>
        <div><dt>{t('local.fileChanges.observedAction')}</dt><dd>{evidenceItem.changeType}</dd></div>
        <div><dt>{evidenceItem.firstChangedAt === evidenceItem.lastChangedAt ? t('local.fileChanges.observedAt') : t('local.fileChanges.firstObserved')}</dt><dd><time dateTime={evidenceItem.firstChangedAt}>{evidenceItem.firstChangedAt}</time></dd></div>
        {evidenceItem.firstChangedAt !== evidenceItem.lastChangedAt && <div><dt>{t('local.fileChanges.lastObserved')}</dt><dd><time dateTime={evidenceItem.lastChangedAt}>{evidenceItem.lastChangedAt}</time></dd></div>}
      </dl>
    </Disclosure>
  </div>
  const diffContent = diffPath && <div className="task-file-diff-view">
    {diffLoading && <p className="task-file-diff-notice" role="status">{t('local.fileChanges.refreshing')}</p>}
    {diffError && <p className="task-file-diff-notice" role="alert">{t('local.fileChanges.diffUnavailable')}</p>}
    {diff && (!diff.available || !diff.diff)
      ? <p className="task-file-diff-notice">{t('local.fileChanges.diffUnavailable')}</p>
      : diff?.diff && <>
        <div className="task-file-diff-toolbar">
          <span className="task-file-diff-layout-label">{t('local.fileChanges.diffLayout')}</span>
          <div className="task-file-diff-layout-actions" role="group" aria-label={t('local.fileChanges.diffLayout')}>
            <Button size="small" aria-pressed={diffLayout === 'unified'} onClick={() => setDiffLayout('unified')}>
              {t('local.fileChanges.diffUnified')}
            </Button>
            <Button size="small" aria-pressed={diffLayout === 'split'} onClick={() => setDiffLayout('split')}>
              {t('local.fileChanges.diffSplit')}
            </Button>
          </div>
          <Button size="small" className="task-file-diff-copy" onClick={() => void copyDiff()}>
            <UiIcon name="copy" size={14}/>
            {t(diffCopyState === 'copied' ? 'local.fileChanges.diffCopied'
              : diffCopyState === 'error' ? 'local.fileChanges.diffCopyFailed' : 'local.fileChanges.diffCopy')}
          </Button>
        </div>
        <div className="task-file-diff-code">
          {diff.truncated
            ? <CopyableCodeBlock copyValue={diff.diff} language="diff">{diff.diff}</CopyableCodeBlock>
            : <PatchDiff patch={diff.diff} options={{
              diffStyle: diffLayout,
              theme: diffTheme === 'dark' ? 'pierre-dark' : 'pierre-light',
              hunkSeparators: 'line-info',
            }}/>}
        </div>
      </>}
    {diff?.truncated && <p className="task-file-diff-notice">{t('local.fileChanges.diffTruncated')}</p>}
  </div>
  const detailContent = selected && <section className="task-file-changes task-file-changes-detail">
      <Button size="small" className="task-file-detail-back" onClick={() => { setEvidenceItem(null); setDiffPath(null) }}><UiIcon name="arrow-left" size={14}/>{t('local.fileChanges.backToFiles')}</Button>
      <div className="task-file-detail-heading">
        <span className="task-file-detail-icon" aria-hidden="true"><UiIcon name="file-code" size={20}/></span>
        <div className="task-file-detail-identity">
          <h3 title={inspectedFilePath}>{inspectedFile.name}</h3>
          {inspectedFile.directory && <p title={inspectedFile.directory}>{inspectedFile.directory}</p>}
        </div>
      </div>
      {evidenceContent}{diffContent}
    </section>
  return <>
    {inspectingInline ? detailContent : <section className="task-file-changes">
      <div className="task-file-changes-header">
        <span className="task-file-changes-mark" aria-hidden="true"><UiIcon name="tool-edit" size={16}/></span>
        <h3 className="task-file-changes-heading">
          {t(isObserved ? 'local.fileChanges.roundTitle' : hasUnverifiedFiles ? 'local.fileChanges.activityCount' : 'local.fileChanges.titleCount', { count })}
          {hasExactDelta && <span className="task-file-changes-delta">
            {value?.summary.additions !== undefined && <span className="task-file-change-added">+{value.summary.additions}</span>}
            {value?.summary.deletions !== undefined && <span className="task-file-change-deleted">-{value.summary.deletions}</span>}
          </span>}
        </h3>
        {loading && <span className="task-file-changes-state">{t('local.fileChanges.refreshing')}</span>}
      </div>
      <div className="task-file-changes-list">
        {error && <div className="task-file-changes-error" role="alert">{t('local.fileChanges.loadFailed')}</div>}
        {displayed.map(item => {
          const target = item.changeType === 'deleted'
            ? undefined
            : absoluteFilePath(value?.rootPath ?? value?.workspacePath, item.path)
          const observedOnly = isObservedOnly(item) || isObserved
          return <div className="task-file-change-row" key={`${item.changeType}:${item.oldPath ?? ''}:${item.path}`}>
            <span className={`task-file-change-status ${observedOnly ? 'is-observed' : `is-${item.changeType}`}`} title={t(observedOnly ? 'local.fileChanges.observed' : `local.fileChanges.status.${item.changeType}`)}>{observedOnly ? t('local.fileChanges.observed') : statusCode(item)}</span>
            <span className="task-file-change-path">
              {item.changeType === 'renamed' && item.oldPath && <><code title={item.oldPath}>{item.oldPath}</code><UiIcon name="arrow-right" size={14}/></>}
              {target
                ? <LocalResourceReference value={target} displayValue={item.path} kind="file" presentation="inline"/>
                : <code title={item.path}>{item.path}</code>}
            </span>
            {item.additions !== undefined && <span className="task-file-change-added">+{item.additions}</span>}
            {item.deletions !== undefined && <span className="task-file-change-deleted">-{item.deletions}</span>}
            {!observedOnly && <Button size="small" className="task-file-change-diff-action" onClick={() => { setDiff(null); setDiffError(false); setDiffLoading(true); setDiffPath(item.path) }}>{t('local.fileChanges.viewDiff')}</Button>}
            {observedOnly && <Button size="small" className="task-file-change-evidence-action" onClick={() => setEvidenceItem(item)}>{t('local.fileChanges.viewEvidence')}</Button>}
          </div>
        })}
        {value?.meta.truncated && <div className="task-file-changes-error">{t('local.fileChanges.truncated')}</div>}
        {hidden > 0 && <Button size="small" className="task-file-changes-more" onClick={() => setShowAll(true)}>
          {t('local.fileChanges.showMore', { count: hidden })}<UiIcon name="chevron-down" size={14}/>
        </Button>}
        {showAll && items.length > INITIAL_VISIBLE_FILES && <Button size="small" className="task-file-changes-more" onClick={() => setShowAll(false)}>
          {t('local.fileChanges.showLess')}<UiIcon name="arrow-up" size={14}/>
        </Button>}
      </div>
    </section>}
    {!inlineDetails && selected && <Drawer
      open
      className="task-file-detail-drawer"
      title={t(diffPath ? 'local.fileChanges.viewDiff' : 'local.fileChanges.viewEvidence')}
      onClose={() => { setEvidenceItem(null); setDiffPath(null) }}
    >{detailContent}</Drawer>}
  </>
}
