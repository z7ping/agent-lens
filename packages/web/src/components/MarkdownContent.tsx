import ReactMarkdown from 'react-markdown'

export interface MarkdownContentProps {
  text: string
  className?: string
}

/**
 * AgentLens 统一 Markdown 渲染入口。
 *
 * 这里保持 react-markdown 的安全默认值：不启用 raw HTML；具体视觉由全局
 * `.markdown` 契约负责，避免 Review / Pi Live / Streaming 各维护一套样式。
 */
export function MarkdownContent({ text, className = '' }: MarkdownContentProps) {
  return <div className={`markdown ${className}`.trim()}><ReactMarkdown>{text}</ReactMarkdown></div>
}
