import { UiIcon } from './UiIcon'

export type AgentLogoSize = 'compact' | 'normal' | 'large'

/** Bundled marks only. Unknown agents keep the neutral icon; do not invent branding. */
const AGENT_LOGOS: Readonly<Record<string, { asset: string; monochrome: boolean }>> = {
  pi: { asset: 'pi.svg', monochrome: true },
  codex: { asset: 'codex.svg', monochrome: true },
  'claude-code': { asset: 'claude-code.svg', monochrome: false },
  hermes: { asset: 'hermes.svg', monochrome: true },
  opencode: { asset: 'opencode.svg', monochrome: false },
}

export function AgentLogo({
  sourceId,
  size = 'normal',
  className = '',
}: {
  sourceId: string
  size?: AgentLogoSize
  className?: string
}) {
  const mark = AGENT_LOGOS[sourceId]
  const classes = ['agent-logo', 'agent-logo--' + size, mark?.monochrome ? 'agent-logo--monochrome' : '', className]
    .filter(Boolean).join(' ')

  return <span className={classes} aria-hidden="true">
    {mark
      ? <img src={'/agent-logos/' + mark.asset} alt="" draggable={false}/>
      : <UiIcon name="agent" size={size === 'large' ? 20 : size === 'normal' ? 16 : 14}/>}
  </span>
}
