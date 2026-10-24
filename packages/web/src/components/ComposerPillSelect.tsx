import type { ReactNode } from 'react'
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
  footer,
  openRequest,
}: {
  value: string
  placeholder: string
  options: ComposerPillOption[]
  disabled?: boolean
  title?: string | undefined
  ariaLabel: string
  control: 'model' | 'thinking'
  onChange(value: string): void
  footer?: ReactNode
  openRequest?: number
}) {
  return <span className={`task-composer-control task-composer-control--${control}`}>
    <SelectMenu
      value={value}
      placeholder={placeholder}
      options={options}
      disabled={disabled}
      title={title}
      ariaLabel={ariaLabel}
      onChange={onChange}
      {...(footer !== undefined ? { footer } : {})}
      {...(openRequest !== undefined ? { openRequest } : {})}
    />
  </span>
}
