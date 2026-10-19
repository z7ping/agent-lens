import { SelectMenu, type SelectMenuOption } from './ui'

export type ComposerPillOption = SelectMenuOption

export function ComposerPillSelect({
  value,
  placeholder,
  options,
  disabled = false,
  title,
  ariaLabel,
  control,
  onChange,
}: {
  value: string
  placeholder: string
  options: ComposerPillOption[]
  disabled?: boolean
  title?: string | undefined
  ariaLabel: string
  control: 'model' | 'thinking'
  onChange(value: string): void
}) {
  return <span className={`pi-live-compose-control pi-live-compose-control--${control}`}><SelectMenu
    value={value}
    placeholder={placeholder}
    options={options}
    disabled={disabled}
    title={title}
    ariaLabel={ariaLabel}
    onChange={onChange}
  /></span>
}
