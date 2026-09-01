const initializedAuditToggles = new WeakSet<HTMLButtonElement>()

function collectAuditToggles(root: ParentNode): HTMLButtonElement[] {
  const matches = Array.from(root.querySelectorAll<HTMLButtonElement>('.task-header .review-audit-toggle'))
  if (root instanceof HTMLButtonElement && root.matches('.task-header .review-audit-toggle')) matches.unshift(root)
  return matches
}

function applyDefaultFullEventView(root: ParentNode = document) {
  for (const button of collectAuditToggles(root)) {
    if (initializedAuditToggles.has(button)) continue
    initializedAuditToggles.add(button)

    // Shared Task Surface 迁移期，Review / Pi Live 仍分别持有 showAllEvents state。
    // 这里只设置首次挂载的默认值；用户之后切回“核心事件”不会被再次覆盖。
    if (button.getAttribute('aria-pressed') === 'false') button.click()
  }
}

/**
 * 统一 Task Surface 的默认详情偏好：首次进入即展示全部可观测事件。
 * 后续等 Review / Pi Live 的 view state 完全下沉到 TaskSurface 后可移除该兼容层。
 */
export function installTaskSurfaceDefaults(): () => void {
  applyDefaultFullEventView()

  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) applyDefaultFullEventView(node)
      }
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  return () => observer.disconnect()
}
