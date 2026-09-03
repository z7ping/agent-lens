import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import './composer-pill-select.css'

export interface ComposerPillOption {
  value: string
  label: string
  description?: string | undefined
}

interface ComposerPillPosition {
  left: number
  top?: number | undefined
  bottom?: number | undefined
  width: number
}

export function ComposerPillSelect({
  value,
  placeholder,
  options,
  disabled = false,
  title,
  ariaLabel,
  className = '',
  menuWidth = 220,
  onChange,
}: {
  value: string
  placeholder: string
  options: ComposerPillOption[]
  disabled?: boolean
  title?: string | undefined
  ariaLabel: string
  className?: string
  menuWidth?: number
  onChange(value: string): void
}) {
  const listboxId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [position, setPosition] = useState<ComposerPillPosition | null>(null)
  const selectedIndex = options.findIndex(option => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const updatePosition = () => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(Math.max(rect.width, menuWidth), Math.max(144, window.innerWidth - 16))
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    const estimatedHeight = Math.min(300, Math.max(56, options.length * 46 + 12))
    const canOpenUp = rect.top >= Math.min(estimatedHeight, 160) + 8
    setPosition(canOpenUp
      ? { left, bottom: window.innerHeight - rect.top + 8, width }
      : { left, top: rect.bottom + 8, width })
  }

  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  const choose = (nextValue: string) => {
    if (nextValue !== value) onChange(nextValue)
    close(true)
  }

  useEffect(() => {
    if (!open) return
    updatePosition()
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    const focusFrame = window.requestAnimationFrame(() => menuRef.current?.focus({ preventScroll: true }))
    const reposition = () => updatePosition()
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close(false)
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    document.addEventListener('pointerdown', dismiss, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      document.removeEventListener('pointerdown', dismiss, true)
    }
  }, [open, options.length, selectedIndex])

  useEffect(() => {
    if (disabled && open) close(false)
  }, [disabled, open])

  const menuStyle: CSSProperties | undefined = position
    ? {
        left: position.left,
        width: position.width,
        ...(position.top !== undefined ? { top: position.top } : {}),
        ...(position.bottom !== undefined ? { bottom: position.bottom } : {}),
      }
    : undefined

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`composer-pill-trigger ${open ? 'is-open' : ''} ${className}`.trim()}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      title={title}
      onClick={() => setOpen(current => !current)}
      onKeyDown={event => {
        if (disabled) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setOpen(true)
        }
      }}
    >
      <span className="composer-pill-trigger-label">{selected?.label ?? placeholder}</span>
      <span className="composer-pill-chevron" aria-hidden="true">⌄</span>
    </button>

    {open && position && createPortal(
      <div
        ref={menuRef}
        id={listboxId}
        className="composer-pill-menu"
        role="listbox"
        tabIndex={-1}
        aria-label={ariaLabel}
        style={menuStyle}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            close(true)
            return
          }
          if (!options.length) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const direction = event.key === 'ArrowDown' ? 1 : -1
            setActiveIndex(current => {
              const origin = current >= 0 ? current : selectedIndex >= 0 ? selectedIndex : 0
              return (origin + direction + options.length) % options.length
            })
            return
          }
          if (event.key === 'Enter' && activeIndex >= 0 && options[activeIndex]) {
            event.preventDefault()
            choose(options[activeIndex].value)
          }
        }}
      >
        {options.map((option, index) => {
          const checked = option.value === value
          return <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={checked}
            className={`composer-pill-option ${checked ? 'is-selected' : ''} ${activeIndex === index ? 'is-active' : ''}`.trim()}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => choose(option.value)}
          >
            <span className="composer-pill-option-copy">
              <b>{option.label}</b>
              {option.description && <small>{option.description}</small>}
            </span>
            <span className="composer-pill-check" aria-hidden="true">{checked ? '✓' : ''}</span>
          </button>
        })}
      </div>,
      document.body,
    )}
  </>
}
