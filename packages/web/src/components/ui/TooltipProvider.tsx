import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

type TooltipAnchor = HTMLElement | SVGElement
type ActiveTooltip = { anchor: TooltipAnchor; text: string }

const TOOLTIP_SELECTOR = '[data-ui-tooltip], [title]'

/**
 * Existing title attributes are normalized on interaction rather than making every
 * feature own a second tooltip. Native browser tooltips never coexist with this UI.
 * Shared Button/IconButton/StatusBadge already emit data-ui-tooltip directly.
 */
function tooltipText(anchor: TooltipAnchor): string {
  const native = anchor.getAttribute('title')
  if (native !== null) {
    anchor.setAttribute('data-ui-tooltip', native)
    anchor.removeAttribute('title')
  }
  return anchor.getAttribute('data-ui-tooltip')?.trim() ?? ''
}

function findAnchor(target: EventTarget | null): TooltipAnchor | null {
  if (!(target instanceof Element)) return null
  const anchor = target.closest<HTMLElement | SVGElement>(TOOLTIP_SELECTOR)
  if (!anchor || anchor.closest('.ui-tooltip')) return null
  return anchor
}

/**
 * One shared, non-interactive tooltip for Web and Desktop WebView.
 * Floating UI handles collision/positioning; event delegation preserves the
 * existing full-text titles on paths, tables and status labels without JSX forks.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  const tooltipId = useId()
  const [active, setActive] = useState<ActiveTooltip | null>(null)
  const tooltipElement = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<ActiveTooltip | null>(null)
  activeRef.current = active
  const hoverRef = useRef<TooltipAnchor | null>(null)
  const focusRef = useRef<TooltipAnchor | null>(null)
  const dismissedRef = useRef<TooltipAnchor | null>(null)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)

  const { refs, floatingStyles } = useFloating({
    open: Boolean(active),
    placement: 'top',
    middleware: [offset(7), flip({ padding: 12 }), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  })

  useLayoutEffect(() => {
    refs.setReference(active?.anchor ?? null)
  }, [active?.anchor, refs])

  useEffect(() => {
    const anchor = active?.anchor
    if (!anchor) return
    const old = anchor.getAttribute('aria-describedby') ?? ''
    const ids = old.split(/\s+/).filter(Boolean)
    if (!ids.includes(tooltipId)) anchor.setAttribute('aria-describedby', [...ids, tooltipId].join(' '))
    return () => {
      const current = anchor.getAttribute('aria-describedby') ?? ''
      const remaining = current.split(/\s+/).filter(id => id && id !== tooltipId)
      if (remaining.length) anchor.setAttribute('aria-describedby', remaining.join(' '))
      else anchor.removeAttribute('aria-describedby')
    }
  }, [active?.anchor, tooltipId])

  useEffect(() => {
    const clearShow = () => window.clearTimeout(showTimer.current)
    const clearHide = () => window.clearTimeout(hideTimer.current)
    const closeSoon = () => {
      clearHide()
      hideTimer.current = window.setTimeout(() => {
        if (!hoverRef.current && !focusRef.current) setActive(null)
      }, 150)
    }
    const show = (anchor: TooltipAnchor, delay: number) => {
      clearShow()
      clearHide()
      const text = tooltipText(anchor)
      if (!text || dismissedRef.current === anchor) return
      const reveal = () => {
        if (anchor.isConnected && dismissedRef.current !== anchor) setActive({ anchor, text: tooltipText(anchor) })
      }
      if (delay) showTimer.current = window.setTimeout(reveal, delay)
      else reveal()
    }

    const pointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const node = event.target instanceof Node ? event.target : null
      if (node && tooltipElement.current?.contains(node)) {
        clearHide()
        return
      }
      const anchor = findAnchor(event.target)
      if (!anchor) return
      if (hoverRef.current === anchor) {
        clearHide()
        return
      }
      hoverRef.current = anchor
      // Close the previous item immediately on rapid navigation between icons.
      if (activeRef.current?.anchor !== anchor && !focusRef.current) setActive(null)
      show(anchor, 240)
    }
    const pointerOut = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const node = event.target instanceof Node ? event.target : null
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null
      const panel = tooltipElement.current
      if (node && panel?.contains(node)) {
        if (next && (panel.contains(next) || hoverRef.current?.contains(next))) return
        closeSoon()
        return
      }
      const anchor = findAnchor(event.target)
      if (!anchor || anchor !== hoverRef.current) return
      if (next && anchor.contains(next)) return
      hoverRef.current = null
      if (dismissedRef.current === anchor) dismissedRef.current = null
      clearShow()
      // The pointer may enter the floating tooltip directly from its trigger.
      // Clear hover ownership in either case, so leaving the tooltip can dismiss it.
      if (next && panel?.contains(next)) {
        clearHide()
        return
      }
      if (!focusRef.current) closeSoon()
    }
    const focusIn = (event: FocusEvent) => {
      const anchor = findAnchor(event.target)
      if (!anchor) return
      focusRef.current = anchor
      dismissedRef.current = null
      show(anchor, 0)
    }
    const focusOut = (event: FocusEvent) => {
      const anchor = findAnchor(event.target)
      if (!anchor || focusRef.current !== anchor) return
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null
      if (next && anchor.contains(next)) return
      focusRef.current = null
      dismissedRef.current = null
      if (!hoverRef.current) closeSoon()
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!activeRef.current) return
      dismissedRef.current = activeRef.current.anchor
      clearShow()
      clearHide()
      setActive(null)
    }

    // React may update a title while the pointer remains on the element (e.g. Copy -> Copied).
    // Normalize those updates too, without observing/re-scanning large streaming trees.
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (!(record.target instanceof HTMLElement || record.target instanceof SVGElement)) continue
        const anchor = record.target
        if (record.attributeName === 'title' && anchor.getAttribute('title') === null) continue
        const text = tooltipText(anchor)
        if (activeRef.current?.anchor === anchor && activeRef.current.text !== text) {
          setActive(previous => previous?.anchor === anchor ? { anchor, text } : previous)
        }
      }
    })
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['title', 'data-ui-tooltip'] })
    document.addEventListener('pointerover', pointerOver, true)
    document.addEventListener('pointerout', pointerOut, true)
    document.addEventListener('focusin', focusIn, true)
    document.addEventListener('focusout', focusOut, true)
    document.addEventListener('keydown', keyDown, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerover', pointerOver, true)
      document.removeEventListener('pointerout', pointerOut, true)
      document.removeEventListener('focusin', focusIn, true)
      document.removeEventListener('focusout', focusOut, true)
      clearShow()
      clearHide()
    }
  }, [])

  return <>
    {children}
    {active && <FloatingPortal>
      <div
        ref={element => {
          tooltipElement.current = element
          refs.setFloating(element)
        }}
        id={tooltipId}
        role="tooltip"
        className="ui-tooltip"
        style={floatingStyles}
        onPointerEnter={() => window.clearTimeout(hideTimer.current)}
        onPointerLeave={() => {
          if (!hoverRef.current && !focusRef.current) {
            hideTimer.current = window.setTimeout(() => setActive(null), 150)
          }
        }}
      >{active.text}</div>
    </FloatingPortal>}
  </>
}
