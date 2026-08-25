export function installInspectorOutsideDismiss(): () => void {
  const onPointerDown = (event: PointerEvent) => {
    const panel = document.querySelector<HTMLElement>('.inspector-panel[role="dialog"][aria-modal="true"]')
    if (!panel) return
    const target = event.target
    if (!(target instanceof Node) || panel.contains(target)) return

    const close = panel.querySelector<HTMLButtonElement>('button[aria-label="关闭事件详情"]')
    close?.click()
  }

  document.addEventListener('pointerdown', onPointerDown)
  return () => document.removeEventListener('pointerdown', onPointerDown)
}
