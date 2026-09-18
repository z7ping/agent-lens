export interface LiveComposerSessionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const LIVE_COMPOSER_DRAFT_PREFIX = 'agent-lens:live-composer:draft:v1:'

export function liveComposerDraftKey(liveId: string, runtimeSessionId: string): string {
  return `${LIVE_COMPOSER_DRAFT_PREFIX}${encodeURIComponent(liveId)}:${encodeURIComponent(runtimeSessionId)}`
}

export function browserLiveComposerSessionStorage(): LiveComposerSessionStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function readLiveComposerDraft(
  key: string,
  storage: LiveComposerSessionStorage | null = browserLiveComposerSessionStorage(),
): string {
  if (!key || !storage) return ''
  try {
    return storage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function writeLiveComposerDraft(
  key: string,
  value: string,
  storage: LiveComposerSessionStorage | null = browserLiveComposerSessionStorage(),
): boolean {
  if (!key || !storage) return false
  try {
    if (!value.trim()) storage.removeItem(key)
    else storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function clearLiveComposerDraft(
  key: string,
  storage: LiveComposerSessionStorage | null = browserLiveComposerSessionStorage(),
): boolean {
  if (!key || !storage) return false
  try {
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

/**
 * Terminal-style input history navigation.
 *
 * Navigation starts only from an empty composer. Once active, ArrowUp/Down can
 * move through history. ArrowDown past the newest item restores the pre-nav
 * draft (normally empty). Any ordinary edit should call reset().
 */
export class ComposerInputHistoryNavigator {
  private index: number | null = null
  private original = ''

  previous(history: readonly string[], current: string): string | null {
    if (!history.length) return null
    if (this.index === null) {
      if (current.trim()) return null
      this.original = current
      this.index = history.length - 1
      return history[this.index] ?? null
    }
    this.index = Math.max(0, this.index - 1)
    return history[this.index] ?? null
  }

  next(history: readonly string[]): string | null {
    if (this.index === null) return null
    if (!history.length) {
      const original = this.original
      this.reset()
      return original
    }
    if (this.index < history.length - 1) {
      this.index += 1
      return history[this.index] ?? null
    }
    const original = this.original
    this.reset()
    return original
  }

  isActive(): boolean {
    return this.index !== null
  }

  reset(): void {
    this.index = null
    this.original = ''
  }
}
