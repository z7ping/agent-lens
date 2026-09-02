export type UiIconName = 'refresh' | 'close' | 'search' | 'sort-up' | 'sort-down' | 'arrow-right' | 'plus' | 'trend' | 'check' | 'upload' | 'alert' | 'dot' | 'drag' | 'chevron-down'

export function UiIcon({ name, size = 16, className }: { name: UiIconName; size?: number; className?: string }) {
  const path = (() => {
    if (name === 'refresh') return <><path d="M13 3v4H9"/><path d="M12.2 6A5 5 0 1 0 13 9"/></>
    if (name === 'close') return <path d="M4 4l8 8M12 4l-8 8"/>
    if (name === 'search') return <><circle cx="7" cy="7" r="3.5"/><path d="m9.7 9.7 3.3 3.3"/></>
    if (name === 'sort-up') return <path d="m4.5 9.5 3.5-3.5 3.5 3.5"/>
    if (name === 'sort-down') return <path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>
    if (name === 'arrow-right') return <><path d="M3 8h9"/><path d="m9 5 3 3-3 3"/></>
    if (name === 'trend') return <><path d="M3 11.5 6.2 8l2.3 2 4.5-5"/><path d="M10 5h3v3"/></>
    if (name === 'check') return <path d="m3.5 8.2 2.7 2.7 6.3-6.3"/>
    if (name === 'upload') return <><path d="M8 11V3"/><path d="m5 6 3-3 3 3"/><path d="M3 11v2h10v-2"/></>
    if (name === 'alert') return <><path d="M8 2.5 14 13H2L8 2.5Z"/><path d="M8 6v3.2"/><path d="M8 11.3h.01"/></>
    if (name === 'dot') return <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>
    if (name === 'drag') return <><circle cx="5.5" cy="4" r=".8" fill="currentColor" stroke="none"/><circle cx="10.5" cy="4" r=".8" fill="currentColor" stroke="none"/><circle cx="5.5" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="10.5" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="5.5" cy="12" r=".8" fill="currentColor" stroke="none"/><circle cx="10.5" cy="12" r=".8" fill="currentColor" stroke="none"/></>
    if (name === 'chevron-down') return <path d="m4.5 6 3.5 3.5L11.5 6"/>
    return <path d="M8 3v10M3 8h10"/>
  })()

  return <svg
    className={className}
    viewBox="0 0 16 16"
    width={size}
    height={size}
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >{path}</svg>
}
