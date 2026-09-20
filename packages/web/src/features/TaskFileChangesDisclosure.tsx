import type { TaskFileChangeDto, TaskFileChangesResponseDto } from '@agent-lens/protocol'
import { useTranslation } from 'react-i18next'
import { LocalResourceReference } from '../components/LocalResourceReference'
import { UiIcon } from '../components/ui'

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

function lineDelta(change: TaskFileChangeDto): string {
  const values: string[] = []
  if (change.additions !== undefined) values.push(`+${change.additions}`)
  if (change.deletions !== undefined) values.push(`-${change.deletions}`)
  return values.join(' ')
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
  if (!value && !loading && !error) return null
  if (value && value.summary.count === 0 && !loading && !error) return null

  const count = value?.summary.count ?? 0
  const hasExactDelta = value?.summary.additions !== undefined || value?.summary.deletions !== undefined
  const summaryDelta = hasExactDelta
    ? [
        value?.summary.additions !== undefined ? `+${value.summary.additions}` : '',
        value?.summary.deletions !== undefined ? `-${value.summary.deletions}` : '',
      ].filter(Boolean).join(' ')
    : ''

  return <details className="task-file-changes">
    <summary>
      <UiIcon className="task-file-changes-chevron" name="chevron-right" size={14}/>
      <span>{t('local.fileChanges.title')}</span>
      {value && <span className="task-file-changes-count">{count}</span>}
      {summaryDelta && <span className="task-file-changes-delta">{summaryDelta}</span>}
      {value && value.summary.observedCount > 0 && value.summary.exactCount === 0
        ? <span className="task-file-changes-observed">{t('local.fileChanges.observed')}</span>
        : null}
      {loading && <span className="task-file-changes-state">{t('local.fileChanges.refreshing')}</span>}
    </summary>
    <div className="task-file-changes-list">
      {error && <div className="task-file-changes-error" role="alert">{t('local.fileChanges.loadFailed')}</div>}
      {value?.items.map(item => {
        const target = item.changeType === 'deleted'
          ? undefined
          : absoluteFilePath(value.rootPath ?? value.workspacePath, item.path)
        const delta = lineDelta(item)
        return <div className="task-file-change-row" key={`${item.changeType}:${item.oldPath ?? ''}:${item.path}`}>
          <span
            className={`task-file-change-status is-${item.changeType}`}
            title={t(`local.fileChanges.status.${item.changeType}`)}
          >{statusCode(item)}</span>
          <span className="task-file-change-path">
            {item.changeType === 'renamed' && item.oldPath
              ? <><code title={item.oldPath}>{item.oldPath}</code><UiIcon name="arrow-right" size={13}/></>
              : null}
            {target
              ? <LocalResourceReference value={target} kind="file" presentation="inline"/>
              : <code title={item.path}>{item.path}</code>}
          </span>
          {delta && <span className="task-file-change-delta">{delta}</span>}
          {item.confidence !== 'exact' && <span className="task-file-change-confidence">{t('local.fileChanges.observedShort')}</span>}
        </div>
      })}
      {!error && !value?.items.length && <div className="task-file-changes-empty">{t('local.fileChanges.empty')}</div>}
    </div>
  </details>
}
