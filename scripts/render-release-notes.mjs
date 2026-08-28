import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryUrl = 'https://github.com/z7ping/agent-lens'

const sectionTitles = new Map([
  ['Added', '新增'],
  ['Changed', '改进'],
  ['Improved', '改进'],
  ['Fixed', '修复'],
  ['Security', '安全'],
  ['Removed', '移除'],
  ['Known limitations', '已知限制'],
  ['Known Limitations', '已知限制'],
  ['新增', '新增'],
  ['改进', '改进'],
  ['修复', '修复'],
  ['安全', '安全'],
  ['移除', '移除'],
  ['已知限制', '已知限制'],
])

export function extractVersionSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`^##\\s+${escaped}(?:（[^\\n]+）)?\\s*$`, 'm')
  const match = changelog.match(heading)
  if (!match || match.index === undefined) {
    throw new Error(`CHANGELOG.md 中没有找到版本 ${version}`)
  }

  const start = match.index + match[0].length
  const remainder = changelog.slice(start).replace(/^\r?\n/, '')
  const nextTopLevel = remainder.search(/^#{1,2}\s+/m)
  return (nextTopLevel >= 0 ? remainder.slice(0, nextTopLevel) : remainder).trim()
}

export function parseReleaseSections(sectionText) {
  const sections = []
  let current = null

  for (const line of sectionText.split(/\r?\n/)) {
    const heading = line.match(/^###\s+(.+?)\s*$/)
    if (heading) {
      const sourceTitle = heading[1].trim()
      current = {
        sourceTitle,
        title: sectionTitles.get(sourceTitle) ?? sourceTitle,
        lines: [],
      }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
  }

  return sections
    .map(section => ({ ...section, lines: trimBlankLines(section.lines) }))
    .filter(section => section.lines.length > 0)
}

export function validateReleaseSections(sections, version) {
  const bullets = sections.flatMap(section => section.lines.filter(line => /^-\s+/.test(line.trim())))
  if (bullets.length === 0) {
    throw new Error(`版本 ${version} 的 CHANGELOG 没有任何发布条目`)
  }

  const meaningful = bullets.filter(line => !/版本更新至\s+[^，,]+[，,]\s*详见本次发布说明/.test(line))
  if (meaningful.length === 0) {
    throw new Error(`版本 ${version} 的 CHANGELOG 仍是占位说明，请先补齐实际变更`)
  }
}

export function renderReleaseNotes({ changelog, version, previousTag = null }) {
  const sectionText = extractVersionSection(changelog, version)
  const sections = parseReleaseSections(sectionText)
  validateReleaseSections(sections, version)

  const parts = [`## AgentLens v${version}`]
  for (const section of sections) {
    parts.push(`### ${section.title}\n${section.lines.join('\n')}`)
  }
  if (previousTag) {
    parts.push(`**完整变更**: ${repositoryUrl}/compare/${previousTag}...v${version}`)
  }
  return `${parts.join('\n\n')}\n`
}

function trimBlankLines(lines) {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start += 1
  while (end > start && !lines[end - 1].trim()) end -= 1
  return lines.slice(start, end)
}

function parseArgs(argv) {
  const options = { version: null, previousTag: null, output: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--version') options.version = argv[++index]
    else if (arg === '--previous-tag') options.previousTag = argv[++index]
    else if (arg === '--output') options.output = argv[++index]
    else if (!arg.startsWith('-') && !options.version) options.version = arg
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const version = options.version ?? packageJson.version
  if (version !== packageJson.version) {
    throw new Error(`Release Notes 版本 ${version} 与 package.json ${packageJson.version} 不一致`)
  }

  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8')
  const notes = renderReleaseNotes({ changelog, version, previousTag: options.previousTag })
  if (options.output) {
    await writeFile(resolve(options.output), notes, 'utf8')
    console.log(`Release Notes 已生成：${options.output}`)
  } else {
    process.stdout.write(notes)
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
