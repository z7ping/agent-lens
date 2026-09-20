import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { LocalFileLink, parseLocalFileTarget } from './LocalFileLink'
import { splitMarkdownFrontmatter, type MarkdownFrontmatter } from './markdown-frontmatter'
import { DEFAULT_MARKDOWN_THEME, type CustomMarkdownThemeId, type MarkdownThemeId } from './markdown-theme'
import { scopedCustomMarkdownCss, useCustomMarkdownThemes } from './markdown-theme-registry'

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
  /** Parse a leading YAML frontmatter block and render it as document metadata. */
  frontmatter?: boolean
  /** Optional document skin. Task messages omit it and retain the shared Task Surface style. */
  theme?: MarkdownThemeId
}

export interface StreamingMarkdownSegments {
  settled: string
  tail: string
}

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <LocalFileLink {...props}/>,
  table: ({ node: _node, ...props }) => <div className="markdown-table-scroll"><table {...props}/></div>,
  pre: ({ node: _node, ...props }) => <CopyableCodeBlock {...props}/>,
}

function markdownUrlTransform(url: string): string {
  return parseLocalFileTarget(url) ? url : defaultUrlTransform(url)
}

function FrontmatterPanel({ value }: { value: MarkdownFrontmatter }) {
  if (value.error) {
    return <div className="markdown-frontmatter" data-invalid="true">
      <CopyableCodeBlock className="markdown-frontmatter-raw">{value.raw}</CopyableCodeBlock>
    </div>
  }
  return <dl className="markdown-frontmatter">
    {value.entries.map(entry => <div className="markdown-frontmatter-row" key={entry.key}>
      <dt>{entry.key}</dt>
      <dd>{entry.value}</dd>
    </div>)}
  </dl>
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
export function MarkdownContent({ text, className = '', streaming = false, frontmatter = false, theme }: MarkdownContentProps) {
  if (theme?.startsWith('custom:')) {
    return <CustomThemedMarkdownContent text={text} className={className} streaming={streaming} frontmatter={frontmatter} theme={theme as CustomMarkdownThemeId}/>
  }
  return <MarkdownBody text={text} className={className} streaming={streaming} frontmatter={frontmatter} theme={theme}/>
}

function CustomThemedMarkdownContent({ text, className, streaming, frontmatter, theme }: { text: string; className: string; streaming: boolean; frontmatter: boolean; theme: CustomMarkdownThemeId }) {
  const themes = useCustomMarkdownThemes()
  const customTheme = themes.find(item => item.id === theme)
  if (!customTheme) return <MarkdownBody text={text} className={className} streaming={streaming} frontmatter={frontmatter} theme={DEFAULT_MARKDOWN_THEME}/>
  return <MarkdownBody text={text} className={className} streaming={streaming} frontmatter={frontmatter} theme={theme} customCss={scopedCustomMarkdownCss(customTheme)}/>
}

function MarkdownBody({ text, className, streaming, frontmatter, theme, customCss }: { text: string; className: string; streaming: boolean; frontmatter: boolean; theme: MarkdownThemeId | undefined; customCss?: string }) {
  const document = frontmatter ? splitMarkdownFrontmatter(text) : { body: text, frontmatter: null }
  const segments = streaming ? splitStreamingMarkdown(document.body) : { settled: document.body, tail: '' }
  return <div id={customCss ? 'write' : undefined} className={`markdown ${streaming ? 'markdown-streaming' : ''} ${className}`.trim()} data-markdown-theme={theme}>
    {customCss && <style>{customCss}</style>}
    {document.frontmatter && <FrontmatterPanel value={document.frontmatter}/>} 
    {segments.settled && <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={markdownUrlTransform}>{segments.settled}</ReactMarkdown>}
    {segments.tail && <div className="markdown-streaming-tail">{segments.tail}</div>}
  </div>
}
