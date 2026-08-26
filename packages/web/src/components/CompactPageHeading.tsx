import type { ReactNode } from 'react'

/**
 * 一级导航已经明确当前页面，工作区内不再重复渲染同名页面标题。
 * 保留组件签名，避免各页面为了表现层收口产生无意义结构改写。
 */
export function CompactPageHeading(_: { title: string; description: string; children?: ReactNode }) {
  return null
}
