import { useEffect, useMemo, useState } from 'react'
import packageMetadata from '../../package.json'
import changelogMarkdown from '../../../../CHANGELOG.md?raw'

const REPOSITORY_URL = 'https://github.com/z7ping/agent-lens'
const CHANGELOG_URL = `${REPOSITORY_URL}/blob/main/CHANGELOG.md`
const RELEASES_URL = `${REPOSITORY_URL}/releases`

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
      current = { title: stripInlineMarkdown(line.replace(/^###\s+/, '')), items: [] }
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

export function ReleaseInfo() {
  const [open, setOpen] = useState(false)
  const changelog = useMemo(
    () => parseCurrentChangelog(changelogMarkdown, packageMetadata.version),
    [],
  )

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  return <>
    <a
      className="header-link header-link-github"
      href={REPOSITORY_URL}
      target="_blank"
      rel="noreferrer"
    >GitHub</a>
    <button className="header-link" type="button" onClick={() => setOpen(true)}>更新日志</button>

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
