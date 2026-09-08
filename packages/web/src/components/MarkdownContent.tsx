import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyableCodeBlock } from './CopyableCodeBlock'

export interface MarkdownContentProps {
  text: string
  className?: string
  /**
   * Streaming content is rendered in stable completed blocks while the current
   * unfinished block stays as plain text. This avoids repeatedly reparsing an
   * incomplete Markdown construct on every token and prevents a full-message
   * formatting jump when generation finishes.
   */
  streaming?: boolean
}

export interface StreamingMarkdownSegments {
  settled: string
  tail: string
}

const markdownComponents: Components = {
  table: ({ node: _node, ...props }) => <div className="markdown-table-scroll"><table {...props}/></div>,
  pre: ({ node: _node, ...props }) => <CopyableCodeBlock {...props}/>,
}

/**
 * Find the last completed Markdown block boundary without splitting an open
 * fenced code block. This is deliberately a presentation boundary detector,
 * not a second Markdown parser: ReactMarkdown remains the only renderer.
 */
export function splitStreamingMarkdown(text: string): StreamingMarkdownSegments {
  let offset = 0
  let settledEnd = 0
  let fenceCharacter = ''
  let fenceLength = 0

  while (offset < text.length) {
    const newline = text.indexOf('\n', offset)
    const lineEnd = newline === -1 ? text.length : newline
    const nextOffset = newline === -1 ? text.length : newline + 1
    const line = text.slice(offset, lineEnd).replace(/\r$/, '')
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/)

    if (fence) {
      const marker = fence[1]!
      const character = marker[0]!
      if (!fenceCharacter) {
        fenceCharacter = character
        fenceLength = marker.length
      } else if (character === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = ''
        fenceLength = 0
      }
    } else if (!fenceCharacter && newline !== -1 && line.trim() === '') {
      settledEnd = nextOffset
    }

    offset = nextOffset
  }

  return {
    settled: text.slice(0, settledEnd),
    tail: text.slice(settledEnd),
  }
}

/**
 * AgentLens 统一 Markdown 渲染入口。
 *
 * react-markdown 负责 CommonMark 与安全渲染（不启用 raw HTML），remark-gfm 统一补齐
 * 表格、任务列表、删除线和自动链接等 GFM 语法；视觉继续由 AgentLens 自己的样式契约负责。
 */
export function MarkdownContent({ text, className = '', streaming = false }: MarkdownContentProps) {
  const segments = streaming ? splitStreamingMarkdown(text) : { settled: text, tail: '' }
  return <div className={`markdown ${streaming ? 'markdown-streaming' : ''} ${className}`.trim()}>
    {segments.settled && <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{segments.settled}</ReactMarkdown>}
    {segments.tail && <div className="markdown-streaming-tail">{segments.tail}</div>}
  </div>
}
