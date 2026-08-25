export type UiIconName = 'refresh' | 'close' | 'search' | 'sort-up' | 'sort-down' | 'arrow-right' | 'plus'

export function UiIcon({ name, size = 16, className }: { name: UiIconName; size?: number; className?: string }) {
  const path = (() => {
    if (name === 'refresh') return <><path d="M13 3v4H9"/><path d="M12.2 6A5 5 0 1 0 13 9"/></>
    if (name === 'close') return <path d="M4 4l8 8M12 4l-8 8"/>
    if (name === 'search') return <><circle cx="7" cy="7" r="3.5"/><path d="m9.7 9.7 3.3 3.3"/></>
    if (name === 'sort-up') return <path d="m4.5 9.5 3.5-3.5 3.5 3.5"/>
    if (name === 'sort-down') return <path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>
    if (name === 'arrow-right') return <><path d="M3 8h9"/><path d="m9 5 3 3-3 3"/></>
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
