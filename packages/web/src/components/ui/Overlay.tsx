import { createPortal } from 'react-dom'
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
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
