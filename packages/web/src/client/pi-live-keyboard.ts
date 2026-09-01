let installed = false
let disposeInstalled: (() => void) | null = null

function activePiLivePage(): HTMLElement | null {
  const page = document.querySelector<HTMLElement>('.pi-live-page')
  if (!page) return null
  const active = document.activeElement
  return !active || active === document.body || page.contains(active) ? page : null
}

/**
 * Pi TUI 一致的全局中断键：Pi Live 获得焦点且正在输出时，Esc 触发现有 abort 流程。
 * 使用事件委托而不是绑死 textarea，保证模型输出过程中用户切换到队列/控制区仍可中断。
 */
export function installPiLiveKeyboard(): () => void {
  if (installed && disposeInstalled) return disposeInstalled
  installed = true

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented
      || event.repeat
      || event.key !== 'Escape'
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
    ) return

    const page = activePiLivePage()
    if (!page) return
    const stop = page.querySelector<HTMLButtonElement>('.pi-live-stop:not(:disabled)')
    if (!stop) return

    event.preventDefault()
    event.stopPropagation()
    stop.click()
  }

  window.addEventListener('keydown', onKeyDown, true)
  disposeInstalled = () => {
    window.removeEventListener('keydown', onKeyDown, true)
    installed = false
    disposeInstalled = null
  }
  return disposeInstalled
}
