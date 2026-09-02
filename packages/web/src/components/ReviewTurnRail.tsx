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
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const index = detail.interactionIndex ?? detail.interactions.map((interaction, ordinal) => ({
    id: interaction.id, ordinal: ordinal + 1, trigger: interaction.trigger, startedAt: interaction.startedAt,
    endedAt: interaction.endedAt, hasError: hasError(detail, ordinal), preview: preview(detail, ordinal),
  }))
  const tips = useMemo(() => index.map(item => item.preview ?? `第 ${item.ordinal} 轮`), [index])

  useEffect(() => {
    let observer: IntersectionObserver | undefined
    let resizeObserver: ResizeObserver | undefined
    let positionFrame = 0
    let observerFrame = 0
    const pane = document.querySelector<HTMLElement>('.review-reader-pane')
    if (!pane) return

    const updatePosition = () => {
      window.cancelAnimationFrame(positionFrame)
      positionFrame = window.requestAnimationFrame(() => {
        const rect = pane.getBoundingClientRect()
        setPosition({
          left: Math.max(4, rect.left + 8),
          top: Math.max(72, Math.min(window.innerHeight - 72, rect.top + rect.height / 2)),
        })
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(updatePosition)
      resizeObserver.observe(pane)
      const shell = pane.closest<HTMLElement>('.app-shell')
      if (shell) resizeObserver.observe(shell)
    }

    observerFrame = window.requestAnimationFrame(() => {
      const shells = [...document.querySelectorAll<HTMLElement>('.review-reader-pane .virtual-round-shell')]
      if (!shells.length || typeof IntersectionObserver === 'undefined') return
      observer = new IntersectionObserver(entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => Math.abs(a.boundingClientRect.top - pane.getBoundingClientRect().top) - Math.abs(b.boundingClientRect.top - pane.getBoundingClientRect().top))[0]
        if (!visible) return
        const index = shells.indexOf(visible.target as HTMLElement)
        if (index >= 0) setActiveIndex(index)
      }, { root: pane, rootMargin: '-12% 0px -68% 0px', threshold: 0 })
      shells.forEach(shell => observer?.observe(shell))
    })

    return () => {
      window.cancelAnimationFrame(positionFrame)
      window.cancelAnimationFrame(observerFrame)
      window.removeEventListener('resize', updatePosition)
      resizeObserver?.disconnect()
      observer?.disconnect()
    }
  }, [detail.id, detail.interactions.length, detail.page.filter, detail.page.direction])

  const jump = (index: number) => {
    const shells = document.querySelectorAll<HTMLElement>('.review-reader-pane .virtual-round-shell')
    const target = shells[index]
    if (!target) return
    setActiveIndex(index)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (index.length < 2 || !position) return null
  return <nav className="turn-rail" style={{ position: 'fixed', ...position }} aria-label="轮次导航">
    {index.map((interaction, index) => <button
      key={interaction.id}
      className={`turn-tick ${activeIndex === index ? 'active' : ''} ${interaction.hasError ? 'err' : ''}`}
      data-tip={`${interaction.trigger === 'background' ? '后台活动' : `第 ${interaction.ordinal} 轮`} · ${tips[index]}`}
      aria-label={`跳到${interaction.trigger === 'background' ? '后台活动' : `第 ${interaction.ordinal} 轮`}`}
      onClick={() => jump(index)}
    ><i/></button>)}
  </nav>
}
