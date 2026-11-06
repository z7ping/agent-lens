/**
 * Gate parent notifications to draft empty/non-empty transitions only.
 *
 * Lexical owns the full draft. The page only needs this boolean to enable the
 * send action, so normal keystrokes must not become parent React updates.
 */
export class ComposerDraftPresenceGate {
  private current: boolean

  constructor(initial = false) {
    this.current = initial
  }

  accept(next: boolean): boolean {
    if (next === this.current) return false
    this.current = next
    return true
  }

  snapshot(): boolean {
    return this.current
  }
}

/** Exact slash commands execute with Enter; Tab completes a selected suggestion. */
export function commandMenuShouldSubmit(query: string | null, commands: readonly { value: string }[]): boolean {
  return query !== null && commands.some(command => command.value === `/${query}`)
}
