import type {
  ButtonHTMLAttributes,
  DetailsHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { UiIcon } from '../UiIcon'
import './ui-primitives.css'

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export type ButtonVariant = 'default' | 'primary' | 'danger'
export type ButtonSize = 'default' | 'small'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

export function Button({
  variant = 'default',
  size = 'default',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return <button
    type={type}
    className={classes('btn', variant !== 'default' && variant, size === 'small' && 'small', loading && 'is-loading', className)}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    {...props}
  >
    {loading && <span className="ui-button-spinner" aria-hidden="true"/>}
    {children}
  </button>
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label': string
  size?: ButtonSize
  variant?: ButtonVariant
}

export function IconButton({
  size = 'default',
  variant = 'default',
  className,
  children,
  type = 'button',
  ...props
}: IconButtonProps) {
  return <button
    type={type}
    className={classes('ui-icon-button', `is-${size}`, `is-${variant}`, className)}
    {...props}
  >{children}</button>
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={classes('ui-field', className)} {...props}/>
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={classes('ui-field', 'ui-textarea', className)} {...props}/>
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={classes('ui-field', 'ui-select', className)} {...props}>{children}</select>
}

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export function StatusBadge({
  tone = 'neutral',
  dot = false,
  children,
  className,
}: {
  tone?: StatusTone
  dot?: boolean
  children: ReactNode
  className?: string
}) {
  return <span className={classes('ui-status-badge', `is-${tone}`, className)}>
    {dot && <span className="ui-status-dot" aria-hidden="true"/>}
    {children}
  </span>
}

export interface DisclosureProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children'> {
  summary: ReactNode
  summaryMeta?: ReactNode
  children: ReactNode
}

export function Disclosure({ summary, summaryMeta, children, className, ...props }: DisclosureProps) {
  return <details className={classes('ui-disclosure', className)} {...props}>
    <summary>
      <UiIcon className="ui-disclosure-chevron" name="chevron-down" size={14}/>
      <span className="ui-disclosure-summary">{summary}</span>
      {summaryMeta && <span className="ui-disclosure-meta">{summaryMeta}</span>}
    </summary>
    <div className="ui-disclosure-body">{children}</div>
  </details>
}

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export function Toolbar({ children, className, role = 'toolbar', ...props }: ToolbarProps) {
  return <div role={role} className={classes('ui-toolbar', className)} {...props}>{children}</div>
}

export interface ToolbarGroupProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  align?: 'start' | 'end'
}

export function ToolbarGroup({
  children,
  className,
  align = 'start',
  ...props
}: ToolbarGroupProps) {
  return <div className={classes('ui-toolbar-group', align === 'end' && 'is-end', className)} {...props}>{children}</div>
}
