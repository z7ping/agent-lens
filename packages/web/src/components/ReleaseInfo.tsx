import { useEffect, useMemo, useState } from 'react'
import packageMetadata from '../../package.json'
import changelogMarkdown from '../../../../CHANGELOG.md?raw'
import { checkWebUpdate, type WebUpdateInfo } from '../client/update'
import { CopyableCodeBlock } from './CopyableCodeBlock'

const REPOSITORY_URL = 'https://github.com/z7ping/agent-lens'
const CHANGELOG_URL = `${REPOSITORY_URL}/blob/main/CHANGELOG.md`
const RELEASES_URL = `${REPOSITORY_URL}/releases`
const SECTION_LABELS: Record<string, string> = {
  Added: '新增',
  Changed: '调整',
  Fixed: '修复',
  Security: '安全',
  Deprecated: '弃用',
  Removed: '移除',
  'Known limitations': '已知限制',
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

function sectionLabel(value: string): string {
  const title = stripInlineMarkdown(value)
  return SECTION_LABELS[title] ?? title
}

function publishedAtLabel(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function parseCurrentChangelog(markdown: string, version: string): CurrentChangelog {
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
      current = { title: sectionLabel(line.replace(/^###\s+/, '')), items: [] }
      sections.push(current)
      continue
    }
    const bullet = line.match(/^\s*-\s+(.+)$/)
    if (bullet && current) current.items.push(stripInlineMarkdown(bullet[1]!))
  }

  return { heading, sections }
}

export function BrandVersion() {
  return <span className="brand-version" title={`当前版本 ${packageMetadata.version}`}>v{packageMetadata.version}</span>
}

function UpdateDialog({ update, onClose }: { update: WebUpdateInfo; onClose(): void }) {
  const publishedAt = publishedAtLabel(update.publishedAt)
  return <div
    className="release-dialog-backdrop"
    role="presentation"
    onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}
  >
    <section className="release-dialog" role="dialog" aria-modal="true" aria-labelledby="web-update-dialog-title">
      <header className="release-dialog-header">
        <div>
          <h2 id="web-update-dialog-title">发现新版本</h2>
          <p>当前 v{update.currentVersion} · 最新 v{update.latestVersion}{publishedAt ? ` · ${publishedAt}` : ''}</p>
        </div>
        <button className="release-dialog-close" type="button" onClick={onClose} aria-label="关闭新版本提示">×</button>
      </header>
      <div className="release-dialog-content web-update-content">
        <section className="release-section">
          <h3>npm / CLI 更新</h3>
          <p>推荐使用 AgentLens 已有更新命令；它会按当前运行时归属处理 npm 后台服务，不接管 Windows Desktop。</p>
          <CopyableCodeBlock className="web-update-command" copyValue={update.installCommand}>{update.installCommand}</CopyableCodeBlock>
          <p className="web-update-fallback">也可以直接执行：</p>
          <CopyableCodeBlock className="web-update-command" copyValue={update.fallbackInstallCommand}>{update.fallbackInstallCommand}</CopyableCodeBlock>
        </section>
        {update.releaseNotes && <section className="release-section">
          <h3>版本说明</h3>
          <CopyableCodeBlock className="web-update-notes" copyValue={update.releaseNotes}>{update.releaseNotes}</CopyableCodeBlock>
        </section>}
      </div>
      <footer className="release-dialog-footer">
        <span>不会自动安装或强制重启</span>
        <div>
          <a href={update.releasePageUrl} target="_blank" rel="noreferrer">查看版本</a>
          <button className="release-footer-button" type="button" onClick={onClose}>稍后</button>
        </div>
      </footer>
    </section>
  </div>
}

export function ReleaseInfo({ runtimeOwner, runtimeReady }: { runtimeOwner: string | null; runtimeReady: boolean }) {
  const [open, setOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [update, setUpdate] = useState<WebUpdateInfo | null>(null)
  const changelog = useMemo(
    () => parseCurrentChangelog(changelogMarkdown, packageMetadata.version),
    [],
  )

  useEffect(() => {
    if (!runtimeReady) return
    let active = true
    void checkWebUpdate(packageMetadata.version, { runtimeOwner }).then(result => {
      if (active) setUpdate(result)
    }).catch(() => undefined)
    return () => { active = false }
  }, [runtimeOwner, runtimeReady])

  useEffect(() => {
    if (!open && !updateOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      setUpdateOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, updateOpen])

  return <>
    {update && <button
      className="header-link header-update-link"
      type="button"
      title={`发现新版本 ${update.latestVersion}`}
      onClick={() => setUpdateOpen(true)}
    >新版本 v{update.latestVersion}</button>}
    <a
      className="header-link header-link-github"
      href={REPOSITORY_URL}
      target="_blank"
      rel="noreferrer"
    >GitHub</a>
    <button className="header-link" type="button" onClick={() => setOpen(true)}>更新日志</button>

    {update && updateOpen && <UpdateDialog update={update} onClose={() => setUpdateOpen(false)} />}

    {open && <div
      className="release-dialog-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <section className="release-dialog" role="dialog" aria-modal="true" aria-labelledby="release-dialog-title">
        <header className="release-dialog-header">
          <div>
            <h2 id="release-dialog-title">更新日志</h2>
            <p>{changelog.heading || `v${packageMetadata.version}`}</p>
          </div>
          <button className="release-dialog-close" type="button" onClick={() => setOpen(false)} aria-label="关闭更新日志">×</button>
        </header>
        <div className="release-dialog-content">
          {changelog.sections.length ? changelog.sections.map(section => <section className="release-section" key={section.title}>
            <h3>{section.title}</h3>
            <ul>{section.items.map((item, index) => <li key={`${section.title}-${index}`}>{item}</li>)}</ul>
          </section>) : <p className="release-empty">当前版本暂无更新日志摘要。</p>}
        </div>
        <footer className="release-dialog-footer">
          <span>AgentLens {packageMetadata.version}</span>
          <div>
            <a href={RELEASES_URL} target="_blank" rel="noreferrer">发布记录</a>
            <a href={CHANGELOG_URL} target="_blank" rel="noreferrer">完整更新日志</a>
          </div>
        </footer>
      </section>
    </div>}
  </>
}
