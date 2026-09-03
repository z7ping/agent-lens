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

export function ReviewTurnRail({ detail, onLoadInteraction }: { detail: ReviewSessionDetailDto; onLoadInteraction?: (ordinal: number) => Promise<void> }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const entries = detail.interactionIndex ?? detail.interactions.map((interaction, ordinal) => ({
    id: interaction.id, ordinal: ordinal + 1, trigger: interaction.trigger, startedAt: interaction.startedAt,
    endedAt: interaction.endedAt, hasError: hasError(detail, ordinal), preview: preview(detail, ordinal),
  }))
  const tips = useMemo(() => entries.map(item => item.preview ?? `第 ${item.ordinal} 轮`), [entries])
  const loadedOrdinalKey = detail.interactions.map(interaction => interaction.ordinal).join(',')

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
      observer = new IntersectionObserver(observedEntries => {
        const visible = observedEntries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => Math.abs(a.boundingClientRect.top - pane.getBoundingClientRect().top) - Math.abs(b.boundingClientRect.top - pane.getBoundingClientRect().top))[0]
        if (!visible) return
        const loadedIndex = shells.indexOf(visible.target as HTMLElement)
        const ordinal = detail.interactions[loadedIndex]?.ordinal
        const index = entries.findIndex(entry => entry.ordinal === ordinal)
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
  }, [detail.id, loadedOrdinalKey, detail.page.filter, detail.page.direction])

  const jump = async (index: number) => {
    const ordinal = entries[index]?.ordinal
    if (!ordinal) return
    const loadedIndex = detail.interactions.findIndex(interaction => interaction.ordinal === ordinal)
    const shells = document.querySelectorAll<HTMLElement>('.review-reader-pane .virtual-round-shell')
    const target = loadedIndex >= 0 ? shells[loadedIndex] : undefined
    if (!target) {
      if (onLoadInteraction) {
        await onLoadInteraction(ordinal)
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        document.querySelector<HTMLElement>('.review-reader-pane .virtual-round-shell')?.scrollIntoView({ block: 'start' })
        setActiveIndex(index)
      }
      return
    }
    setActiveIndex(index)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (entries.length < 2 || !position) return null
  return <nav className="turn-rail" style={{ position: 'fixed', ...position }} aria-label="轮次导航">
    {entries.map((interaction, index) => <button
      key={interaction.id}
      className={`turn-tick ${activeIndex === index ? 'active' : ''} ${interaction.hasError ? 'err' : ''}`}
      data-tip={`${interaction.trigger === 'background' ? '后台活动' : `第 ${interaction.ordinal} 轮`} · ${tips[index]}`}
      aria-label={`跳到${interaction.trigger === 'background' ? '后台活动' : `第 ${interaction.ordinal} 轮`}`}
      onClick={() => void jump(index)}
    ><i/></button>)}
  </nav>
}
