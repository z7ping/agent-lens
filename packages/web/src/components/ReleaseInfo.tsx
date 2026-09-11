import { useEffect, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import packageMetadata from '../../package.json'
import changelogMarkdown from '../../../../CHANGELOG.md?raw'
import { checkWebUpdate, type WebUpdateInfo } from '../client/update'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { Button, Dialog } from './ui'

const REPOSITORY_URL = 'https://github.com/z7ping/agent-lens'
const CHANGELOG_URL = `${REPOSITORY_URL}/blob/main/CHANGELOG.md`
const RELEASES_URL = `${REPOSITORY_URL}/releases`
const SECTION_KEYS: Record<string, string> = {
  Added: 'section.Added',
  Changed: 'section.Changed',
  Fixed: 'section.Fixed',
  Security: 'section.Security',
  Deprecated: 'section.Deprecated',
  Removed: 'section.Removed',
  'Known limitations': 'section.knownLimitations',
}

interface ChangelogSection {
  title: string
  items: string[]
}

interface CurrentChangelog {
  heading: string
  sections: ChangelogSection[]
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .trim()
}

function sectionLabel(value: string, t: TFunction): string {
  const title = stripInlineMarkdown(value)
  const key = SECTION_KEYS[title]
  return key ? t(key) : title
}

function publishedAtLabel(value: string | null, locale: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return date.toLocaleString(locale, { hour12: false })
}

function parseCurrentChangelog(markdown: string, version: string, t: TFunction): CurrentChangelog {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex(line => line.startsWith(`## ${version}`))
  if (start < 0) return { heading: `v${version}`, sections: [] }

  const heading = stripInlineMarkdown(lines[start]!.replace(/^##\s+/, ''))
  const sections: ChangelogSection[] = []
  let current: ChangelogSection | null = null

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (/^##\s+/.test(line)) break
    if (/^###\s+/.test(line)) {
      current = { title: sectionLabel(line.replace(/^###\s+/, ''), t), items: [] }
      sections.push(current)
      continue
    }
    const bullet = line.match(/^\s*-\s+(.+)$/)
    if (bullet && current) current.items.push(stripInlineMarkdown(bullet[1]!))
  }

  return { heading, sections }
}

export function BrandVersion() {
  const { t } = useTranslation('release')
  return <span className="brand-version" title={t('currentVersion', { version: packageMetadata.version })}>v{packageMetadata.version}</span>
}

function UpdateDialog({ update, onClose }: { update: WebUpdateInfo; onClose(): void }) {
  const { t, i18n } = useTranslation('release')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const publishedAt = publishedAtLabel(update.publishedAt, locale)
  return <Dialog
    open
    className="release-dialog-overlay"
    title={t('updateTitle')}
    description={t('updateDescription', { current: update.currentVersion, latest: update.latestVersion, published: publishedAt ? t('publishedSuffix', { time: publishedAt }) : '' })}
    onClose={onClose}
    footer={<div className="release-dialog-footer">
      <span>{t('noAutoInstall')}</span>
      <div>
        <a href={update.releasePageUrl} target="_blank" rel="noreferrer">{t('viewRelease')}</a>
        <Button size="small" onClick={onClose}>{t('later')}</Button>
      </div>
    </div>}
  >
    <div className="release-dialog-content web-update-content">
      <section className="release-section">
        <h3>{t('npmCliTitle')}</h3>
        <p>{t('npmCliDescription')}</p>
        <CopyableCodeBlock className="web-update-command" copyValue={update.installCommand}>{update.installCommand}</CopyableCodeBlock>
        <p className="web-update-fallback">{t('fallbackCommand')}</p>
        <CopyableCodeBlock className="web-update-command" copyValue={update.fallbackInstallCommand}>{update.fallbackInstallCommand}</CopyableCodeBlock>
      </section>
      {update.releaseNotes && <section className="release-section">
        <h3>{t('releaseNotes')}</h3>
        <CopyableCodeBlock className="web-update-notes" copyValue={update.releaseNotes}>{update.releaseNotes}</CopyableCodeBlock>
      </section>}
    </div>
  </Dialog>
}

export function ReleaseInfo({ runtimeOwner, runtimeReady }: { runtimeOwner: string | null; runtimeReady: boolean }) {
  const { t } = useTranslation('release')
  const [open, setOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [update, setUpdate] = useState<WebUpdateInfo | null>(null)
  const changelog = useMemo(
    () => parseCurrentChangelog(changelogMarkdown, packageMetadata.version, t),
    [t],
  )

  useEffect(() => {
    if (!runtimeReady) return
    let active = true
    void checkWebUpdate(packageMetadata.version, { runtimeOwner }).then(result => {
      if (active) setUpdate(result)
    }).catch(() => undefined)
    return () => { active = false }
  }, [runtimeOwner, runtimeReady])

  return <>
    {update && <button
      className="header-link header-update-link"
      type="button"
      title={t('newVersionTitle', { version: update.latestVersion })}
      onClick={() => {
        setOpen(false)
        setUpdateOpen(true)
      }}
    >{t('newVersion', { version: update.latestVersion })}</button>}
    <a
      className="header-link header-link-github"
      href={REPOSITORY_URL}
      target="_blank"
      rel="noreferrer"
    >GitHub</a>
    <button className="header-link" type="button" onClick={() => {
      setUpdateOpen(false)
      setOpen(true)
    }}>{t('changelog')}</button>

    {update && updateOpen && <UpdateDialog update={update} onClose={() => setUpdateOpen(false)} />}

    <Dialog
      open={open}
      className="release-dialog-overlay"
      title={t('changelog')}
      description={changelog.heading || `v${packageMetadata.version}`}
      onClose={() => setOpen(false)}
      footer={<div className="release-dialog-footer">
        <span>AgentLens {packageMetadata.version}</span>
        <div>
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">{t('releases')}</a>
          <a href={CHANGELOG_URL} target="_blank" rel="noreferrer">{t('fullChangelog')}</a>
        </div>
      </div>}
    >
      <div className="release-dialog-content">
        {changelog.sections.length ? changelog.sections.map(section => <section className="release-section" key={section.title}>
          <h3>{section.title}</h3>
          <ul>{section.items.map((item, index) => <li key={`${section.title}-${index}`}>{item}</li>)}</ul>
        </section>) : <p className="release-empty">{t('empty')}</p>}
      </div>
    </Dialog>
  </>
}
