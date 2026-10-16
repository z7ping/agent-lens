import { useEffect, useState } from 'react'
import type { TaskFileChangeDto, TaskFileChangesResponseDto, TaskFileDiffResponseDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { AgentLensApi } from '../client/api'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { LocalResourceReference } from '../components/LocalResourceReference'
import { Button, Drawer, UiIcon } from '../components/ui'

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
}: {
  value: TaskFileChangesResponseDto | null
  loading?: boolean
  error?: string
}) {
  const { t } = useTranslation('review')
  const [showAll, setShowAll] = useState(false)
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [diff, setDiff] = useState<TaskFileDiffResponseDto | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState(false)
  const [evidenceItem, setEvidenceItem] = useState<TaskFileChangeDto | null>(null)
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
  const displayed = showAll ? items : items.slice(0, INITIAL_VISIBLE_FILES)
  const hidden = items.length - displayed.length
  const hasExactDelta = value?.summary.additions !== undefined || value?.summary.deletions !== undefined
  const isObserved = Boolean(value?.interactionId)
  return <>
    <section className="task-file-changes">
      <div className="task-file-changes-header">
        <span className="task-file-changes-mark" aria-hidden="true"><UiIcon name="tool-edit" size={16}/></span>
        <h3 className="task-file-changes-heading">
          {t(isObserved ? 'local.fileChanges.roundTitle' : 'local.fileChanges.titleCount', { count })}
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
    </section>
    {evidenceItem && <Drawer open title={evidenceItem.path} onClose={() => setEvidenceItem(null)}>
      <div className="task-file-change-evidence">
        <p>{t('local.fileChanges.observationDisclaimer')}</p>
        <dl>
          <dt>{t('local.fileChanges.evidenceType')}</dt>
          <dd>{evidenceItem.evidence.map(kind => t(`local.fileChanges.evidenceKinds.${kind}`)).join(' · ') || t('local.fileChanges.notRecorded')}</dd>
          <dt>{t('local.fileChanges.firstObserved')}</dt>
          <dd>{evidenceItem.firstChangedAt}</dd>
          <dt>{t('local.fileChanges.lastObserved')}</dt>
          <dd>{evidenceItem.lastChangedAt}</dd>
          <dt>{t('local.fileChanges.observedAction')}</dt>
          <dd>{t(`local.fileChanges.status.${evidenceItem.changeType}`)}</dd>
        </dl>
      </div>
    </Drawer>}
    {diffPath && <Drawer open title={diffPath} onClose={() => setDiffPath(null)}>
      {diffLoading && <p>{t('local.fileChanges.refreshing')}</p>}
      {diffError && <p role="alert">{t('local.fileChanges.diffUnavailable')}</p>}
      {diff && (!diff.available || !diff.diff)
        ? <p>{t('local.fileChanges.diffUnavailable')}</p>
        : diff?.diff && <CopyableCodeBlock copyValue={diff.diff} language="diff">{diff.diff}</CopyableCodeBlock>}
      {diff?.truncated && <p>{t('local.fileChanges.diffTruncated')}</p>}
    </Drawer>}
  </>
}
