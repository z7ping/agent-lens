import ReactMarkdown from 'react-markdown'
import './markdown-content.css'

export interface MarkdownContentProps {
  text: string
  className?: string
}

type TableAlign = 'left' | 'center' | 'right'

interface MarkdownBlock {
  kind: 'markdown'
  text: string
}

interface TableBlock {
  kind: 'table'
  header: string[]
  aligns: Array<TableAlign | undefined>
  rows: string[][]
}

type ContentBlock = MarkdownBlock | TableBlock

function hasUnescapedTrailingPipe(value: string): boolean {
  if (!value.endsWith('|')) return false
  let slashCount = 0
  for (let index = value.length - 2; index >= 0 && value[index] === '\\'; index -= 1) slashCount += 1
  return slashCount % 2 === 0
}

function splitTableRow(line: string): string[] {
  let source = line.trim()
  if (source.startsWith('|')) source = source.slice(1)
  if (hasUnescapedTrailingPipe(source)) source = source.slice(0, -1)

  const cells: string[] = []
  let current = ''
  let escaped = false
  let inlineCode = false

  for (const character of source) {
    if (escaped) {
      current += `\\${character}`
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '`') {
      inlineCode = !inlineCode
      current += character
      continue
    }
    if (character === '|' && !inlineCode) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (escaped) current += '\\'
  cells.push(current.trim())
  return cells
}

function delimiterAlignment(cell: string): TableAlign | undefined | null {
  const value = cell.replace(/\s+/g, '')
  if (!/^:?-{3,}:?$/.test(value)) return null
  if (value.startsWith(':') && value.endsWith(':')) return 'center'
  if (value.endsWith(':')) return 'right'
  if (value.startsWith(':')) return 'left'
  return undefined
}

function parseTableHeader(headerLine: string, delimiterLine: string): Pick<TableBlock, 'header' | 'aligns'> | null {
  if (!headerLine.includes('|') || !delimiterLine.includes('|')) return null
  const header = splitTableRow(headerLine)
  const delimiter = splitTableRow(delimiterLine)
  if (header.length < 2 || delimiter.length !== header.length) return null

  const aligns: Array<TableAlign | undefined> = []
  for (const cell of delimiter) {
    const alignment = delimiterAlignment(cell)
    if (alignment === null) return null
    aligns.push(alignment)
  }
  return { header, aligns }
}

function normalizeRow(cells: string[], width: number): string[] {
  if (cells.length === width) return cells
  if (cells.length > width) return cells.slice(0, width)
  return [...cells, ...Array.from({ length: width - cells.length }, () => '')]
}

function splitContent(text: string): ContentBlock[] {
  const lines = text.split('\n')
  const blocks: ContentBlock[] = []
  const markdown: string[] = []
  let fence: '```' | '~~~' | null = null

  const flushMarkdown = () => {
    if (!markdown.length) return
    blocks.push({ kind: 'markdown', text: markdown.join('\n') })
    markdown.length = 0
  }

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? ''
    const trimmed = line.trimStart()
    const fenceMarker = trimmed.startsWith('```') ? '```' : trimmed.startsWith('~~~') ? '~~~' : null

    if (fence) {
      markdown.push(line)
      if (fenceMarker === fence) fence = null
      index += 1
      continue
    }
    if (fenceMarker) {
      fence = fenceMarker
      markdown.push(line)
      index += 1
      continue
    }

    const nextLine = lines[index + 1]
    const table = nextLine === undefined ? null : parseTableHeader(line, nextLine)
    if (!table) {
      markdown.push(line)
      index += 1
      continue
    }

    flushMarkdown()
    const rows: string[][] = []
    index += 2
    while (index < lines.length) {
      const bodyLine = lines[index] ?? ''
      if (!bodyLine.trim() || !bodyLine.includes('|')) break
      const cells = splitTableRow(bodyLine)
      if (cells.length < 2) break
      rows.push(normalizeRow(cells, table.header.length))
      index += 1
    }
    blocks.push({ kind: 'table', header: table.header, aligns: table.aligns, rows })
  }

  flushMarkdown()
  return blocks
}

function MarkdownCell({ text }: { text: string }) {
  return <ReactMarkdown>{text}</ReactMarkdown>
}

/**
 * AgentLens 统一 Markdown 渲染入口。
 *
 * react-markdown 继续负责 CommonMark 与安全渲染（不启用 raw HTML）；这里补齐
 * Agent 输出里高频的 GFM 管道表格，同时保留统一的列表、表格和代码视觉契约。
 */
export function MarkdownContent({ text, className = '' }: MarkdownContentProps) {
  const blocks = splitContent(text)
  return <div className={`markdown ${className}`.trim()}>
    {blocks.map((block, blockIndex) => block.kind === 'markdown'
      ? <ReactMarkdown key={`markdown-${blockIndex}`}>{block.text}</ReactMarkdown>
      : <div key={`table-${blockIndex}`} className="markdown-table-scroll">
          <table>
            <thead>
              <tr>{block.header.map((cell, index) => <th key={index} style={block.aligns[index] ? { textAlign: block.aligns[index] } : undefined}><MarkdownCell text={cell}/></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={block.aligns[cellIndex] ? { textAlign: block.aligns[cellIndex] } : undefined}><MarkdownCell text={cell}/></td>)}</tr>)}
            </tbody>
          </table>
        </div>)}
  </div>
}
