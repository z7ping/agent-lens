import { SelectMenu, type SelectMenuOption } from './SelectMenu'

export type ComposerPillOption = SelectMenuOption

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
  return <SelectMenu
    value={value}
    placeholder={placeholder}
    options={options}
    disabled={disabled}
    title={title}
    ariaLabel={ariaLabel}
    className={className}
    menuWidth={menuWidth}
    variant="pill"
    onChange={onChange}
  />
}
