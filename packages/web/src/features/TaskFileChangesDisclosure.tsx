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

function statusCode(change: TaskFileChangeDto): string {
  if (change.changeType === 'added') return 'A'
  if (change.changeType === 'modified') return 'M'
  if (change.changeType === 'deleted') return 'D'
  if (change.changeType === 'renamed') return 'R'
  return '?'
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

  useEffect(() => {
    if (!diffPath || !value || value.interactionId) return
    const controller = new AbortController()
    setDiff(null)
    setDiffError(false)
    setDiffLoading(true)
    void api.reviewFileDiff(value.logicalSessionId, diffPath, controller.signal)
      .then(result => { if (!controller.signal.aborted) setDiff(result) })
      .catch(() => { if (!controller.signal.aborted) setDiffError(true) })
      .finally(() => { if (!controller.signal.aborted) setDiffLoading(false) })
    return () => controller.abort()
  }, [diffPath, value?.logicalSessionId, value?.interactionId])

  if (!value && !loading && !error) return null
  if (value && value.summary.count === 0 && !loading && !error) return null

  const count = value?.summary.count ?? 0
  const displayed = showAll ? value?.items ?? [] : (value?.items ?? []).slice(0, INITIAL_VISIBLE_FILES)
  const hidden = count - displayed.length
  const hasExactDelta = value?.summary.additions !== undefined || value?.summary.deletions !== undefined
  const isObserved = Boolean(value?.interactionId)
  return <>
    <details className="task-file-changes" open>
      <summary>
        <span className="task-file-changes-mark" aria-hidden="true"><UiIcon name="file-diff" size={16}/></span>
        <span className="task-file-changes-heading">
          {t(isObserved ? 'local.fileChanges.roundTitle' : 'local.fileChanges.titleCount', { count })}
          {hasExactDelta && <span className="task-file-changes-delta">
            {value?.summary.additions !== undefined && <span className="task-file-change-added">+{value.summary.additions}</span>}
            {value?.summary.deletions !== undefined && <span className="task-file-change-deleted">-{value.summary.deletions}</span>}
          </span>}
        </span>
        {!hasExactDelta && value && value.summary.observedCount > 0 && <span className="task-file-changes-observed">{t('local.fileChanges.observed')}</span>}
        {loading && <span className="task-file-changes-state">{t('local.fileChanges.refreshing')}</span>}
        <UiIcon className="task-file-changes-chevron" name="chevron-right" size={14}/>
      </summary>
      <div className="task-file-changes-list">
        {error && <div className="task-file-changes-error" role="alert">{t('local.fileChanges.loadFailed')}</div>}
        {displayed.map(item => {
          const target = item.changeType === 'deleted'
            ? undefined
            : absoluteFilePath(value?.rootPath ?? value?.workspacePath, item.path)
          return <div className="task-file-change-row" key={`${item.changeType}:${item.oldPath ?? ''}:${item.path}`}>
            <span className={`task-file-change-status is-${item.changeType}`} title={t(`local.fileChanges.status.${item.changeType}`)}>{statusCode(item)}</span>
            <span className="task-file-change-path">
              {item.changeType === 'renamed' && item.oldPath && <><code title={item.oldPath}>{item.oldPath}</code><UiIcon name="arrow-right" size={14}/></>}
              {target
                ? <LocalResourceReference value={target} displayValue={item.path} kind="file" presentation="inline"/>
                : <code title={item.path}>{item.path}</code>}
            </span>
            {item.additions !== undefined && <span className="task-file-change-added">+{item.additions}</span>}
            {item.deletions !== undefined && <span className="task-file-change-deleted">-{item.deletions}</span>}
            {item.confidence !== 'exact' && <span className="task-file-change-confidence">{t('local.fileChanges.observedShort')}</span>}
            {item.confidence === 'exact' && !isObserved && <Button size="small" className="task-file-change-diff-action" onClick={() => setDiffPath(item.path)}>{t('local.fileChanges.viewDiff')}</Button>}
          </div>
        })}
        {value?.meta.truncated && <div className="task-file-changes-error">{t('local.fileChanges.truncated')}</div>}
        {hidden > 0 && <Button size="small" className="task-file-changes-more" onClick={() => setShowAll(true)}>
          {t('local.fileChanges.showMore', { count: hidden })}<UiIcon name="chevron-down" size={14}/>
        </Button>}
        {showAll && count > INITIAL_VISIBLE_FILES && <Button size="small" className="task-file-changes-more" onClick={() => setShowAll(false)}>
          {t('local.fileChanges.showLess')}<UiIcon name="chevron-up" size={14}/>
        </Button>}
      </div>
    </details>
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
