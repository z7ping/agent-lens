import type { SVGProps } from 'react'

export type UiIconName =
  | 'agent'
  | 'alert'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'arrow-up'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'close'
  | 'collapse'
  | 'copy'
  | 'dot'
  | 'drag'
  | 'exclamation'
  | 'expand'
  | 'moon'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'send'
  | 'sort-down'
  | 'sort-up'
  | 'sun'
  | 'trend'
  | 'upload'

export interface UiIconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: UiIconName
  size?: number
}

export function UiIcon({ name, size = 16, className, ...props }: UiIconProps) {
  const path = (() => {
    if (name === 'refresh') return <><path d="M13 3v4H9"/><path d="M12.2 6A5 5 0 1 0 13 9"/></>
    if (name === 'close') return <path d="M4 4l8 8M12 4l-8 8"/>
    if (name === 'search') return <><circle cx="7" cy="7" r="3.5"/><path d="m9.7 9.7 3.3 3.3"/></>
    if (name === 'sort-up') return <path d="m4.5 9.5 3.5-3.5 3.5 3.5"/>
    if (name === 'sort-down') return <path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>
    if (name === 'chevron-right') return <path d="m6 4.5 3.5 3.5L6 11.5"/>
    if (name === 'arrow-left') return <><path d="M13 8H4"/><path d="m7 5-3 3 3 3"/></>
    if (name === 'arrow-right') return <><path d="M3 8h9"/><path d="m9 5 3 3-3 3"/></>
    if (name === 'arrow-up') return <><path d="M8 13V4"/><path d="m5 7 3-3 3 3"/></>
    if (name === 'arrow-down') return <><path d="M8 3v9"/><path d="m5 9 3 3 3-3"/></>
    if (name === 'send') return <><path d="M8 13V4"/><path d="m4.5 7.5 3.5-3.5 3.5 3.5"/></>
    if (name === 'trend') return <><path d="M3 11.5 6.2 8l2.3 2 4.5-5"/><path d="M10 5h3v3"/></>
    if (name === 'check') return <path d="m3.5 8.2 2.7 2.7 6.3-6.3"/>
    if (name === 'copy') return <><rect x="5.2" y="5.2" width="7.3" height="7.3" rx="1.2"/><path d="M10.5 5.2V4.7A1.2 1.2 0 0 0 9.3 3.5H4.7a1.2 1.2 0 0 0-1.2 1.2v4.6a1.2 1.2 0 0 0 1.2 1.2h.5"/></>
    if (name === 'upload') return <><path d="M8 11V3"/><path d="m5 6 3-3 3 3"/><path d="M3 11v2h10v-2"/></>
    if (name === 'alert') return <><path d="M8 2.5 14 13H2L8 2.5Z"/><path d="M8 6v3.2"/><path d="M8 11.3h.01"/></>
    if (name === 'exclamation') return <><path d="M8 3.5v6"/><path d="M8 12.3h.01"/></>
    if (name === 'dot') return <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>
    if (name === 'drag') return <><circle cx="5.5" cy="4" r=".8" fill="currentColor" stroke="none"/><circle cx="10.5" cy="4" r=".8" fill="currentColor" stroke="none"/><circle cx="5.5" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="10.5" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="5.5" cy="12" r=".8" fill="currentColor" stroke="none"/><circle cx="10.5" cy="12" r=".8" fill="currentColor" stroke="none"/></>
    if (name === 'chevron-down') return <path d="m4.5 6 3.5 3.5L11.5 6"/>
    if (name === 'agent') return <><rect x="3" y="4" width="10" height="9" rx="2"/><path d="M6 4V2.8M10 4V2.8M6.2 8h.01M9.8 8h.01M6.3 10.5h3.4"/></>
    if (name === 'sun') return <><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9"/></>
    if (name === 'moon') return <path d="M12.6 10.2A5.2 5.2 0 0 1 5.8 3.4a5.3 5.3 0 1 0 6.8 6.8Z"/>
    if (name === 'expand') return <><path d="M6.2 2.5H2.5v3.7"/><path d="m2.8 2.8 3.4 3.4"/><path d="M9.8 13.5h3.7V9.8"/><path d="m13.2 13.2-3.4-3.4"/></>
    if (name === 'collapse') return <><path d="M6.2 2.5v3.7H2.5"/><path d="m2.8 6 3.4-3.4"/><path d="M9.8 13.5V9.8h3.7"/><path d="m13.2 10-3.4 3.4"/></>
    return <path d="M8 3v10M3 8h10"/>
  })()

  return <svg
    {...props}
    className={className}
    viewBox="0 0 16 16"
    width={size}
    height={size}
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >{path}</svg>
}
