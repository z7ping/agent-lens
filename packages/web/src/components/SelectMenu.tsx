import { createPortal } from 'react-dom'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { UiIcon } from './UiIcon'
import './select-menu.css'

export interface SelectMenuOption {
  value: string
  label: string
  description?: string | undefined
  keywords?: string | undefined
  disabled?: boolean | undefined
}

export type SelectMenuVariant = 'toolbar' | 'field' | 'pill'

interface MenuPosition {
  left: number
  top?: number | undefined
  bottom?: number | undefined
  width: number
}

export function SelectMenu({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = '请选择',
  variant = 'toolbar',
  className = '',
  disabled = false,
  searchable = false,
  searchPlaceholder = '搜索…',
  menuWidth = 220,
  title,
}: {
  value: string
  options: SelectMenuOption[]
  onChange(value: string): void
  ariaLabel: string
  placeholder?: string
  variant?: SelectMenuVariant
  className?: string
  disabled?: boolean
  searchable?: boolean
  searchPlaceholder?: string
  menuWidth?: number
  title?: string | undefined
}) {
  const listboxId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeValue, setActiveValue] = useState('')
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const selected = options.find(option => option.value === value)
  const filteredOptions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return options
    return options.filter(option => [option.label, option.description, option.keywords]
      .filter(Boolean)
      .some(text => text!.toLocaleLowerCase().includes(needle)))
  }, [options, query])
  const enabledOptions = useMemo(() => filteredOptions.filter(option => !option.disabled), [filteredOptions])

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(Math.max(rect.width, menuWidth), Math.max(176, window.innerWidth - 16))
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    const estimatedHeight = Math.min(360, Math.max(64, options.length * 48 + (searchable ? 54 : 12)))
    const openAbove = window.innerHeight - rect.bottom < Math.min(estimatedHeight, 220) && rect.top > window.innerHeight - rect.bottom
    setPosition(openAbove
      ? { left, bottom: window.innerHeight - rect.top + 8, width }
      : { left, top: rect.bottom + 8, width })
  }, [menuWidth, options.length, searchable])

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    setQuery('')
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [])

  const choose = useCallback((nextValue: string) => {
    if (nextValue !== value) onChange(nextValue)
    close(true)
  }, [close, onChange, value])

  useEffect(() => {
    if (!open) return
    updatePosition()
    setActiveValue(selected && !selected.disabled ? selected.value : enabledOptions[0]?.value ?? '')
    const focusFrame = requestAnimationFrame(() => (searchable ? searchRef.current : menuRef.current)?.focus({ preventScroll: true }))
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close(false)
    }
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    document.addEventListener('pointerdown', dismiss, true)
    return () => {
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('pointerdown', dismiss, true)
    }
  }, [close, open, searchable, selected?.value, updatePosition])

  useEffect(() => {
    if (disabled && open) close(false)
  }, [close, disabled, open])

  useEffect(() => {
    if (!open || enabledOptions.some(option => option.value === activeValue)) return
    setActiveValue(enabledOptions[0]?.value ?? '')
  }, [activeValue, enabledOptions, open])

  const moveActive = (direction: 1 | -1) => {
    if (!enabledOptions.length) return
    const index = enabledOptions.findIndex(option => option.value === activeValue)
    const origin = index >= 0 ? index : direction > 0 ? -1 : 0
    const next = enabledOptions[(origin + direction + enabledOptions.length) % enabledOptions.length]!
    setActiveValue(next.value)
    requestAnimationFrame(() => document.getElementById(`${listboxId}-${next.value}`)?.scrollIntoView({ block: 'nearest' }))
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActiveValue((event.key === 'Home' ? enabledOptions[0] : enabledOptions.at(-1))?.value ?? '')
    } else if (event.key === 'Enter' && activeValue) {
      event.preventDefault()
      choose(activeValue)
    }
  }

  const menuStyle: CSSProperties | undefined = position ? {
    left: position.left,
    width: position.width,
    ...(position.top !== undefined ? { top: position.top } : {}),
    ...(position.bottom !== undefined ? { bottom: position.bottom } : {}),
  } : undefined

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`select-menu-trigger select-menu-trigger-${variant} ${open ? 'is-open' : ''} ${className}`.trim()}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      title={title}
      onClick={() => setOpen(current => !current)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setOpen(true)
        }
      }}
    >
      <span className="select-menu-trigger-copy">
        <span className="select-menu-trigger-label">{selected?.label ?? placeholder}</span>
        {variant === 'field' && selected?.description && <small>{selected.description}</small>}
      </span>
      <UiIcon className="select-menu-chevron" name="chevron-down" size={14}/>
    </button>

    {open && position && createPortal(
      <div ref={menuRef} className={`select-menu-popover select-menu-popover-${variant}`} style={menuStyle} onKeyDown={handleMenuKeyDown}>
        {searchable && <div className="select-menu-search-wrap">
          <UiIcon name="search" size={16}/>
          <input
            ref={searchRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            aria-controls={listboxId}
            aria-activedescendant={activeValue ? `${listboxId}-${activeValue}` : undefined}
          />
        </div>}
        <div id={listboxId} className="select-menu-options" role="listbox" aria-label={ariaLabel} tabIndex={searchable ? undefined : -1} aria-activedescendant={activeValue ? `${listboxId}-${activeValue}` : undefined}>
          {filteredOptions.map(option => {
            const checked = option.value === value
            const active = option.value === activeValue
            return <button
              id={`${listboxId}-${option.value}`}
              key={option.value}
              type="button"
              role="option"
              aria-selected={checked}
              tabIndex={-1}
              disabled={option.disabled}
              className={`select-menu-option ${checked ? 'is-selected' : ''} ${active ? 'is-active' : ''}`.trim()}
              onMouseEnter={() => { if (!option.disabled) setActiveValue(option.value) }}
              onClick={() => choose(option.value)}
            >
              <span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>
              <span className="select-menu-check" aria-hidden="true">{checked && <UiIcon name="check" size={16}/>}</span>
            </button>
          })}
          {!filteredOptions.length && <div className="select-menu-empty">没有匹配项</div>}
        </div>
      </div>,
      document.body,
    )}
  </>
}
