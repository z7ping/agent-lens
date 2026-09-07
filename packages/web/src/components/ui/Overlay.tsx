import { createPortal } from 'react-dom'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { UiIcon } from '../UiIcon'
import { IconButton } from './Primitives'
import './overlay.css'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function useOverlayFocus({
  open,
  onClose,
  panelRef,
}: {
  open: boolean
  onClose(): void
  panelRef: RefObject<HTMLDivElement | null>
}) {
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useLayoutEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel)?.focus({ preventScroll: true })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter(element => element.offsetParent !== null)
      if (!focusable.length) {
        event.preventDefault()
        panelRef.current.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      requestAnimationFrame(() => previous?.focus({ preventScroll: true }))
    }
  }, [open, panelRef])
}

interface OverlayFrameProps {
  open: boolean
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose(): void
  closeOnBackdrop?: boolean
  closeDisabled?: boolean
  className?: string
  kind: 'dialog' | 'drawer'
  side?: 'left' | 'right'
}

function OverlayFrame({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  closeOnBackdrop = true,
  closeDisabled = false,
  className,
  kind,
  side = 'right',
}: OverlayFrameProps) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlayFocus({ open, onClose, panelRef })
  if (!open) return null

  return createPortal(
    <div
      className={`ui-overlay ui-overlay-${kind} ${kind === 'drawer' ? `is-${side}` : ''} ${className ?? ''}`.trim()}
      role="presentation"
      onMouseDown={event => {
        if (!closeDisabled && closeOnBackdrop && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={`ui-overlay-panel ui-${kind}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="ui-overlay-header">
          <div className="ui-overlay-heading">
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <IconButton aria-label="关闭" disabled={closeDisabled} onClick={onClose}><UiIcon name="close" size={16}/></IconButton>
        </header>
        <div className="ui-overlay-body">{children}</div>
        {footer && <footer className="ui-overlay-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

export type DialogProps = Omit<OverlayFrameProps, 'kind' | 'side'>
export type DrawerProps = Omit<OverlayFrameProps, 'kind'>

export function Dialog(props: DialogProps) {
  return <OverlayFrame {...props} kind="dialog"/>
}

export function Drawer(props: DrawerProps) {
  return <OverlayFrame {...props} kind="drawer"/>
}

export interface PopoverProps {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  children: ReactNode
  onClose(): void
  className?: string
  placement?: 'right-end' | 'bottom-end'
  gap?: number
}

export function Popover({
  open,
  anchorRef,
  children,
  onClose,
  className,
  placement = 'bottom-end',
  gap = 8,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })

  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useLayoutEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (!anchor || !panel) return

      const margin = 12
      const anchorRect = anchor.getBoundingClientRect()
      const panelRect = panel.getBoundingClientRect()
      const panelWidth = Math.min(panelRect.width, window.innerWidth - margin * 2)
      const panelHeight = Math.min(panelRect.height, window.innerHeight - margin * 2)
      let left = placement === 'right-end' ? anchorRect.right + gap : anchorRect.right - panelWidth
      let top = placement === 'right-end' ? anchorRect.bottom - panelHeight : anchorRect.bottom + gap

      if (placement === 'right-end' && left + panelWidth > window.innerWidth - margin) {
        left = anchorRect.left - panelWidth - gap
      }
      if (placement === 'bottom-end' && top + panelHeight > window.innerHeight - margin) {
        top = anchorRect.top - panelHeight - gap
      }

      left = Math.min(Math.max(left, margin), window.innerWidth - panelWidth - margin)
      top = Math.min(Math.max(top, margin), window.innerHeight - panelHeight - margin)
      setStyle({
        position: 'fixed',
        top,
        left,
        right: 'auto',
        bottom: 'auto',
        maxWidth: `calc(100vw - ${margin * 2}px)`,
        maxHeight: `calc(100vh - ${margin * 2}px)`,
        visibility: 'visible',
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef, gap, open, placement])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return
      closeRef.current()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closeRef.current()
      requestAnimationFrame(() => anchorRef.current?.focus({ preventScroll: true }))
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [anchorRef, open])

  if (!open) return null
  return createPortal(
    <div
      ref={panelRef}
      className={`ui-popover ${className ?? ''}`.trim()}
      style={style}
      onPointerDown={event => event.stopPropagation()}
    >{children}</div>,
    document.body,
  )
}
