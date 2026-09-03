import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './markdown-content.css'

export interface MarkdownContentProps {
  text: string
  className?: string
}

const markdownComponents: Components = {
  table: ({ node: _node, ...props }) => <div className="markdown-table-scroll"><table {...props}/></div>,
}

/**
 * AgentLens 统一 Markdown 渲染入口。
 *
 * react-markdown 负责 CommonMark 与安全渲染（不启用 raw HTML），remark-gfm 统一补齐
 * 表格、任务列表、删除线和自动链接等 GFM 语法；视觉继续由 AgentLens 自己的样式契约负责。
 */
export function MarkdownContent({ text, className = '' }: MarkdownContentProps) {
  return <div className={`markdown ${className}`.trim()}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown>
  </div>
}
