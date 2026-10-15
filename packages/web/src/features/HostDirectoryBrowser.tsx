import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { browseHostProjectDirectory, type HostDirectoryListing } from '../client/host-directory'
import { Button, Dialog, Input } from '../components/ui'
import { UiIcon } from '../components/UiIcon'

export interface HostDirectoryBrowserProps {
  open: boolean
  initialPath?: string
  recentPaths: string[]
  onChoose(path: string): void
  onClose(): void
}

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/** Host directory navigation belongs to the browser; selecting never launches a task. */
export function HostDirectoryBrowser({ open, initialPath, recentPaths, onChoose, onClose }: HostDirectoryBrowserProps) {
  const { t } = useTranslation('task')
  const [requestedPath, setRequestedPath] = useState<string | undefined>(initialPath)
  const [pathInput, setPathInput] = useState(initialPath ?? '')
  const [filter, setFilter] = useState('')
  const [listing, setListing] = useState<HostDirectoryListing>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setRequestedPath(initialPath || undefined)
    setPathInput(initialPath ?? '')
    setFilter('')
  }, [open, initialPath])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setListing(undefined)
    void browseHostProjectDirectory(requestedPath, controller.signal).then(
      value => {
        if (controller.signal.aborted) return
        setListing(value)
        setPathInput(value.path)
        setLoading(false)
      },
      reason => {
        if (controller.signal.aborted) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      },
    )
    return () => controller.abort()
  }, [open, requestedPath])

  const visible = useMemo(() => (listing?.directories ?? []).filter(item => item.name.toLowerCase().includes(filter.trim().toLowerCase())), [listing, filter])
  const navigate = (path?: string) => { setListing(undefined); setLoading(true); setFilter(''); setRequestedPath(path) }
  const submitPath = () => {
    const path = pathInput.trim()
    if (path) navigate(path)
  }

  return <Dialog
    open={open}
    onClose={onClose}
    size="large"
    className="host-directory-browser"
    title={t('center.newTask.browserTitle')}
    description={t('center.newTask.browserDescription')}
    footer={<>
      <Button onClick={onClose}>{t('center.newTask.browserCancel')}</Button>
      <Button variant="primary" disabled={loading || !listing?.selectable} onClick={() => listing && onChoose(listing.path)}>
        {t('center.newTask.browserUseDirectory')}
      </Button>
    </>}
  >
    <div className="host-directory-browser-content">
      <div className="host-directory-browser-location">
        <Input
          value={pathInput}
          onChange={event => setPathInput(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) submitPath() }}
          aria-label={t('center.newTask.browserPath')}
          placeholder={t('center.newTask.pathPlaceholder')}
        />
        <Button disabled={loading || !pathInput.trim()} onClick={submitPath}>{t('center.newTask.browserGo')}</Button>
      </div>
      <div className="host-directory-browser-shortcuts">
        <Button size="small" disabled={loading || !listing?.parentPath} onClick={() => navigate(listing?.parentPath ?? undefined)}>
          <UiIcon name="arrow-up" size={14}/> {t('center.newTask.browserParent')}
        </Button>
        <Button size="small" disabled={loading} onClick={() => navigate(undefined)}>{t('center.newTask.browserHome')}</Button>
        {listing?.roots.map(root => <Button key={root} size="small" title={root} disabled={loading} onClick={() => navigate(root)}>{root}</Button>)}
      </div>
      {listing && <nav className="host-directory-browser-breadcrumbs" aria-label={t('center.newTask.browserBreadcrumbs')}>
        {listing.breadcrumbs.map((part, index) => <span key={part.path}>
          {index > 0 && <UiIcon name="chevron-right" size={12}/>}
          <Button size="small" disabled={loading || index === listing.breadcrumbs.length - 1} title={part.path} onClick={() => navigate(part.path)}>{part.name}</Button>
        </span>)}
      </nav>}
      {recentPaths.length > 0 && <div className="host-directory-browser-recent">
        <span>{t('center.newTask.recentDirectories')}</span>
        {recentPaths.map(path => <Button key={path} size="small" title={path} onClick={() => navigate(path)} disabled={loading}>{folderName(path)}</Button>)}
      </div>}
      <div className="host-directory-browser-results-head">
        <span>{listing?.path ?? t('center.newTask.browserDirectories')}</span>
        <Input
          value={filter}
          onChange={event => setFilter(event.target.value)}
          aria-label={t('center.newTask.browserFilter')}
          placeholder={t('center.newTask.browserFilter')}
          disabled={loading || !listing}
        />
      </div>
      {loading ? <div className="host-directory-browser-state" role="status">{t('center.newTask.browserLoading')}</div>
        : error ? <div className="host-directory-browser-state is-error" role="alert">{error}</div>
          : visible.length ? <div className="host-directory-browser-list" aria-label={t('center.newTask.browserDirectories')}>
            {visible.map(item => <Button className="host-directory-browser-item" key={item.path} title={item.path} onClick={() => navigate(item.path)}>
              <UiIcon name="folder-open" size={16}/> <span>{item.name}</span> <UiIcon name="chevron-right" size={14}/>
            </Button>)}
          </div> : <div className="host-directory-browser-state">{t('center.newTask.browserEmpty')}</div>}
      {listing?.truncated && <p className="host-directory-browser-note">{t('center.newTask.browserTruncated')}</p>}
      {listing && !listing.selectable && <p className="host-directory-browser-note">{t('center.newTask.browserReadOnly')}</p>}
    </div>
  </Dialog>
}
