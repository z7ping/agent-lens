/**
 * One-shot entry positioning for Review / Live / Hub readers.
 * Follows layout changes only during the initial settle period; explicit reader
 * gestures immediately end it. Long-running streaming remains owned by the
 * existing LiveFollowController, not by this helper.
 */
export function settleReaderAtLatest(
  getReader: () => HTMLElement | null,
  isCurrent: () => boolean,
  maxFrames = 90,
): () => void {
  let frame: number | null = null
  let reader: HTMLElement | null = null
  let cancelled = false
  let stable = 0
  let previousHeight = -1
  let previousTarget = -1
  let frames = 0
  const onIntent = () => stop()
  const watch = (next: HTMLElement) => {
    if (reader === next) return
    if (reader) unwatch(reader)
    reader = next
    reader.addEventListener('wheel', onIntent, { passive: true })
    reader.addEventListener('touchstart', onIntent, { passive: true })
    reader.addEventListener('pointerdown', onIntent, { passive: true })
    reader.addEventListener('keydown', onIntent)
  }
  const unwatch = (current: HTMLElement) => {
    current.removeEventListener('wheel', onIntent)
    current.removeEventListener('touchstart', onIntent)
    current.removeEventListener('pointerdown', onIntent)
    current.removeEventListener('keydown', onIntent)
  }
  const stop = () => {
    cancelled = true
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
    if (reader) unwatch(reader)
    reader = null
  }
  const tick = () => {
    frame = null
    if (cancelled || !isCurrent() || ++frames > maxFrames) { stop(); return }
    const next = getReader()
    if (!next) { frame = window.requestAnimationFrame(tick); return }
    watch(next)
    const target = Math.max(0, next.scrollHeight - next.clientHeight)
    if (Math.abs(next.scrollTop - target) > 1) next.scrollTop = target
    stable = next.scrollHeight === previousHeight && target === previousTarget ? stable + 1 : 0
    previousHeight = next.scrollHeight
    previousTarget = target
    // Allow virtualized rounds to mount and update their estimates.
    if (stable >= 10) { stop(); return }
    frame = window.requestAnimationFrame(tick)
  }
  frame = window.requestAnimationFrame(tick)
  return stop
}

/** Bring the just-submitted turn into view without scrolling the outer page. */
export function scrollReaderToLastUserTurn(reader: HTMLElement): boolean {
  const users = reader.querySelectorAll<HTMLElement>('[data-task-message-role="user"]')
  const latest = users.item(users.length - 1)
  if (!latest) return false
  const offset = latest.getBoundingClientRect().top - reader.getBoundingClientRect().top
  const top = Math.max(0, reader.scrollTop + offset - 24)
  reader.scrollTop = Math.min(top, Math.max(0, reader.scrollHeight - reader.clientHeight))
  return true
}
