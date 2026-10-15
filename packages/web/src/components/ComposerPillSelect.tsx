import { SelectMenu, type SelectMenuOption } from './ui'

export type ComposerPillOption = SelectMenuOption

export function ComposerPillSelect({
  value,
  placeholder,
  options,
  disabled = false,
  title,
  ariaLabel,
  onChange,
}: {
  value: string
  placeholder: string
  options: ComposerPillOption[]
  disabled?: boolean
  title?: string | undefined
  ariaLabel: string
  onChange(value: string): void
}) {
  return <SelectMenu
    value={value}
    placeholder={placeholder}
    options={options}
    disabled={disabled}
    title={title}
    ariaLabel={ariaLabel}
    onChange={onChange}
  />
}
