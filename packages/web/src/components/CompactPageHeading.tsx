import type { ReactNode } from 'react'

/**
 * 一级导航已经明确当前页面，工作区内不再重复渲染同名页面标题。
 * children 仍作为紧凑的页面状态/辅助信息保留，避免去重标题时误删有效信息。
 */
export function CompactPageHeading({ children }: { title: string; description: string; children?: ReactNode }) {
  return children ?? null
}
