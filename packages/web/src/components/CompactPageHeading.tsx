import type { ReactNode } from 'react'

export function CompactPageHeading({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <header className="compact-page-heading">
    <div className="compact-page-heading-main">
      <h1 style={{ order: 0 }}>{title}</h1>
      {children}
      <button className="heading-help" type="button" aria-label={`查看${title}说明`} data-tip={description}>i</button>
    </div>
  </header>
}
