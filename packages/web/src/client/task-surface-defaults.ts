const userOverrodeAuditView = new WeakSet<HTMLButtonElement>()
const applyingDefault = new WeakSet<HTMLButtonElement>()

function collectAuditToggles(root: ParentNode): HTMLButtonElement[] {
  const matches = Array.from(root.querySelectorAll<HTMLButtonElement>('.task-header .review-audit-toggle'))
  if (root instanceof HTMLButtonElement && root.matches('.task-header .review-audit-toggle')) matches.unshift(root)
  return matches
}

function ensureDefaultFullEventView(button: HTMLButtonElement) {
  if (
    button.disabled
    || userOverrodeAuditView.has(button)
    || applyingDefault.has(button)
    || button.getAttribute('aria-pressed') !== 'false'
  ) return

  applyingDefault.add(button)
  button.click()
  queueMicrotask(() => applyingDefault.delete(button))
}

function applyDefaultFullEventView(root: ParentNode = document) {
  for (const button of collectAuditToggles(root)) ensureDefaultFullEventView(button)
}

/**
 * 统一 Task Surface 的默认详情偏好：首次进入即展示全部可观测事件。
 * Review / Pi Live 迁移期仍分别持有 showAllEvents state，所以这里仅负责默认值；
 * 用户主动切回“核心事件”后会保留其选择，不会被观察器强制改回。
 */
export function installTaskSurfaceDefaults(): () => void {
  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted) return
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('.task-header .review-audit-toggle')
      : null
    if (target) userOverrodeAuditView.add(target)
  }

  document.addEventListener('click', onClick, true)
  applyDefaultFullEventView()

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLButtonElement) {
        ensureDefaultFullEventView(record.target)
        continue
      }
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) applyDefaultFullEventView(node)
      }
    }
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed'],
  })

  return () => {
    observer.disconnect()
    document.removeEventListener('click', onClick, true)
  }
}
