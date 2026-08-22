import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'

export function VirtualRoundMount({
  children,
  eager = false,
  estimate = 220,
}: {
  children: ReactNode
  eager?: boolean
  estimate?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(eager)
  const [height, setHeight] = useState(estimate)

  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setMounted(true)
      return
    }
    const root = element.closest('.review-reader-pane')
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0]
      if (entry?.isIntersecting) setMounted(true)
    }, {
      root,
      rootMargin: '1200px 0px',
      threshold: 0,
    })
    observer.observe(element)
    return () => observer.disconnect()
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
    style={mounted ? undefined : { height: `${height}px` }}
  >
    {mounted ? children : null}
  </div>
}
