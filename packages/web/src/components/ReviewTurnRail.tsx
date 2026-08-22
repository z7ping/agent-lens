import { useEffect, useMemo, useState } from 'react'
import type { ReviewMessageNodeDto, ReviewSessionDetailDto, ReviewToolNodeDto } from '@agent-lens/protocol'

function preview(detail: ReviewSessionDetailDto, index: number): string {
  const interaction = detail.interactions[index]
  if (!interaction) return ''
  const user = interaction.nodes.find((node): node is ReviewMessageNodeDto => node.type === 'message' && node.role === 'user')
  const text = user?.text?.replace(/\s+/g, ' ').trim()
  if (text) return text.length > 72 ? `${text.slice(0, 72)}…` : text
  return interaction.trigger === 'background' ? '后台活动' : `第 ${interaction.ordinal} 轮`
}

function hasError(detail: ReviewSessionDetailDto, index: number): boolean {
  const interaction = detail.interactions[index]
  return interaction?.nodes.some((node): node is ReviewToolNodeDto => node.type === 'tool' && node.status === 'error') ?? false
}

export function ReviewTurnRail({ detail }: { detail: ReviewSessionDetailDto }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const tips = useMemo(() => detail.interactions.map((_, index) => preview(detail, index)), [detail])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const pane = document.querySelector<HTMLElement>('.review-reader-pane')
      const shells = [...document.querySelectorAll<HTMLElement>('.review-reader-pane .virtual-round-shell')]
      if (!pane || !shells.length || typeof IntersectionObserver === 'undefined') return
      const observer = new IntersectionObserver(entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => Math.abs(a.boundingClientRect.top - pane.getBoundingClientRect().top) - Math.abs(b.boundingClientRect.top - pane.getBoundingClientRect().top))[0]
        if (!visible) return
        const index = shells.indexOf(visible.target as HTMLElement)
        if (index >= 0) setActiveIndex(index)
      }, { root: pane, rootMargin: '-12% 0px -68% 0px', threshold: 0 })
      shells.forEach(shell => observer.observe(shell))
      ;(pane as HTMLElement & { __agentLensTurnObserver?: IntersectionObserver }).__agentLensTurnObserver?.disconnect()
      ;(pane as HTMLElement & { __agentLensTurnObserver?: IntersectionObserver }).__agentLensTurnObserver = observer
    })
    return () => {
      window.cancelAnimationFrame(frame)
      const pane = document.querySelector<HTMLElement>('.review-reader-pane') as (HTMLElement & { __agentLensTurnObserver?: IntersectionObserver }) | null
      pane?.__agentLensTurnObserver?.disconnect()
      if (pane) delete pane.__agentLensTurnObserver
    }
  }, [detail.id, detail.interactions.length, detail.page.filter, detail.page.direction])

  const jump = (index: number) => {
    const shells = document.querySelectorAll<HTMLElement>('.review-reader-pane .virtual-round-shell')
    const target = shells[index]
    if (!target) return
    setActiveIndex(index)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (detail.interactions.length < 2) return null
  return <nav className="turn-rail" style={{ position: 'fixed', left: '324px', top: '110px', bottom: '44px' }} aria-label="轮次导航">
    {detail.interactions.map((interaction, index) => <button
      key={interaction.id}
      className={`turn-tick ${activeIndex === index ? 'active' : ''} ${hasError(detail, index) ? 'err' : ''}`}
      data-tip={`${interaction.trigger === 'background' ? '后台活动' : `第 ${interaction.ordinal} 轮`} · ${tips[index]}`}
      aria-label={`跳到${interaction.trigger === 'background' ? '后台活动' : `第 ${interaction.ordinal} 轮`}`}
      onClick={() => jump(index)}
    ><i/><i/><i/></button>)}
  </nav>
}
