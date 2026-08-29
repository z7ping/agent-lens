import { isValidElement, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'

export const REVIEW_ROUND_ROOT_MARGIN_PX = 1400
export const REVIEW_ROUND_UNMOUNT_DELAY_MS = 320

export function VirtualRoundMount({
  children,
  eager = false,
  estimate = 220,
  interactionId,
}: {
  children: ReactNode
  eager?: boolean
  estimate?: number
  interactionId?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const unmountTimerRef = useRef<number | null>(null)
  const [mounted, setMounted] = useState(eager)
  const [height, setHeight] = useState(estimate)
  const childInteractionId = isValidElement<{ interaction?: { id?: string } }>(children)
    ? children.props.interaction?.id
    : undefined
  const stableInteractionId = interactionId ?? childInteractionId

  const cancelPendingUnmount = () => {
    if (unmountTimerRef.current === null) return
    window.clearTimeout(unmountTimerRef.current)
    unmountTimerRef.current = null
  }

  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setMounted(true)
      return
    }
    const root = element.closest('.review-reader-pane')
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      if (entry.isIntersecting) {
        cancelPendingUnmount()
        setMounted(true)
        return
      }

      cancelPendingUnmount()
      unmountTimerRef.current = window.setTimeout(() => {
        unmountTimerRef.current = null
        const current = ref.current
        if (!current) return
        const active = document.activeElement
        if (active instanceof Node && current.contains(active)) return
        setMounted(false)
      }, REVIEW_ROUND_UNMOUNT_DELAY_MS)
    }, {
      root,
      rootMargin: `${REVIEW_ROUND_ROOT_MARGIN_PX}px 0px`,
      threshold: 0,
    })
    observer.observe(element)
    return () => {
      cancelPendingUnmount()
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    if (!mounted) return
    const element = ref.current
    if (!element) return
    const measure = () => {
      const next = Math.ceil(element.getBoundingClientRect().height)
      if (next > 0) setHeight(next)
    }
    const frame = requestAnimationFrame(measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [mounted])

  return <div
    ref={ref}
    className="virtual-round-shell"
    data-mounted={mounted ? 'true' : 'false'}
    data-interaction-id={stableInteractionId || undefined}
    style={mounted ? undefined : { height: `${height}px`, position: 'relative' }}
  >
    {!mounted && stableInteractionId && <span
      className="interaction-block virtual-round-anchor"
      data-interaction-id={stableInteractionId}
      aria-hidden="true"
      style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0, margin: 0, padding: 0, border: 0 }}
    />}
    {mounted ? children : null}
  </div>
}
