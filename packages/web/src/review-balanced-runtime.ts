/*
 * 任务复盘轻度降噪交互层。
 *
 * 这里只处理展示与阅读上下文：轮次连续展开、轮次导航轨、会话阅读位置。
 * 不读取业务数据源，不改 ClientModel / DTO，也不接管 SSE。
 */

const sessionPositions = new Map<string, number>()
const boundPages = new WeakSet<HTMLElement>()
const boundPanes = new WeakSet<HTMLElement>()
const boundRounds = new WeakSet<HTMLDetailsElement>()
let currentSessionKey = ''
let scheduledFrame = 0

function activeSessionKey(page: HTMLElement): string {
  const active = page.querySelector<HTMLElement>('.session-item-active .session-item-title')
  return active?.textContent?.trim() ?? ''
}

function saveReadingPosition(page: HTMLElement, pane: HTMLElement): void {
  const key = activeSessionKey(page) || currentSessionKey
  if (!key) return
  sessionPositions.set(key, pane.scrollTop)
  if (sessionPositions.size > 80) {
    const first = sessionPositions.keys().next().value
    if (typeof first === 'string') sessionPositions.delete(first)
  }
}

function sessionHasRunningTool(page: HTMLElement): boolean {
  return page.querySelector('.execution-row[data-status="running"]') !== null
}

function ensureRoundNav(page: HTMLElement): HTMLButtonElement | null {
  const nav = page.querySelector<HTMLElement>('.round-nav')
  if (!nav) return null

  let latest: HTMLButtonElement | null = null
  for (const button of nav.querySelectorAll<HTMLButtonElement>('button')) {
    const label = button.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    if (label === '最近一轮') {
      if (!button.hidden) button.hidden = true
      button.setAttribute('aria-hidden', 'true')
      continue
    }
    if (label.includes('跳到最新') || label === '↓ 最新') {
      latest = button
      if (button.textContent !== '↓ 最新') button.textContent = '↓ 最新'
      if (!button.classList.contains('round-nav-latest')) button.classList.add('round-nav-latest')
    }
  }
  return latest
}

function ensureFourMetrics(page: HTMLElement): void {
  const metrics = page.querySelector<HTMLElement>('.review-metrics')
  if (!metrics || metrics.querySelector('[data-balanced-zero-errors]')) return
  const hasErrorMetric = Array.from(metrics.querySelectorAll<HTMLElement>('.review-metric span')).some(item => item.textContent?.trim() === '错误')
  if (hasErrorMetric) return
  const metric = document.createElement('div')
  metric.className = 'review-metric'
  metric.dataset.balancedZeroErrors = 'true'
  metric.innerHTML = '<b>0</b><span>错误</span>'
  metrics.insertBefore(metric, metrics.lastElementChild)
}

function ensureRoundsStayOpen(page: HTMLElement): void {
  for (const round of page.querySelectorAll<HTMLDetailsElement>('details.interaction-block')) {
    if (!round.open) round.open = true
    if (boundRounds.has(round)) continue
    boundRounds.add(round)
    const summary = round.querySelector<HTMLElement>(':scope > .interaction-summary')
    summary?.setAttribute('aria-expanded', 'true')
    summary?.setAttribute('title', '轮次保持展开；思考过程、工具执行和原始事件仍可按需展开')
    summary?.addEventListener('click', event => event.preventDefault())
    round.addEventListener('toggle', () => {
      if (!round.open) round.open = true
    })
  }
}

function shellLabel(shell: HTMLElement, index: number): { label: string; tip: string; error: boolean; background: boolean } {
  const round = shell.querySelector<HTMLElement>('.interaction-block')
  const title = round?.querySelector<HTMLElement>('.interaction-title')?.textContent?.trim() || `第 ${index + 1} 轮`
  const preview = round?.querySelector<HTMLElement>('.interaction-preview')?.textContent?.trim() ?? ''
  const error = round?.classList.contains('interaction-has-error') ?? false
  const background = title === '后台活动'
  return {
    label: title,
    tip: [title, error ? '有错误' : '', preview].filter(Boolean).join(' · '),
    error,
    background,
  }
}

function updateActiveTick(page: HTMLElement, pane: HTMLElement): void {
  const rail = page.querySelector<HTMLElement>('.review-turn-rail')
  if (!rail) return
  const shells = Array.from(page.querySelectorAll<HTMLElement>('.review-flow > .virtual-round-shell'))
  const ticks = Array.from(rail.querySelectorAll<HTMLButtonElement>('.review-turn-tick'))
  if (!shells.length || !ticks.length) return

  const paneTop = pane.getBoundingClientRect().top
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  shells.forEach((shell, index) => {
    const distance = Math.abs(shell.getBoundingClientRect().top - paneTop - 76)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  ticks.forEach((tick, index) => tick.classList.toggle('is-active', index === best))
}

function ensureTurnRail(page: HTMLElement, pane: HTMLElement): void {
  const shells = Array.from(page.querySelectorAll<HTMLElement>('.review-flow > .virtual-round-shell'))
  let rail = page.querySelector<HTMLElement>('.review-turn-rail')
  if (!shells.length) {
    rail?.remove()
    return
  }
  if (!rail) {
    rail = document.createElement('nav')
    rail.className = 'review-turn-rail'
    rail.setAttribute('aria-label', '轮次导航')
    pane.appendChild(rail)
  }

  if (rail.childElementCount !== shells.length) {
    rail.replaceChildren(...shells.map((shell, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'review-turn-tick'
      button.innerHTML = '<i></i><i></i><i></i>'
      button.addEventListener('click', () => {
        const top = shell.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 72
        pane.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      })
      return button
    }))
  }

  const ticks = Array.from(rail.querySelectorAll<HTMLButtonElement>('.review-turn-tick'))
  ticks.forEach((tick, index) => {
    const shell = shells[index]
    if (!shell) return
    const info = shellLabel(shell, index)
    tick.dataset.tip = info.tip
    tick.setAttribute('aria-label', `跳到${info.label}`)
    tick.classList.toggle('is-error', info.error)
    tick.classList.toggle('is-background', info.background)
  })
  updateActiveTick(page, pane)
}

function restoreSessionPosition(page: HTMLElement, pane: HTMLElement, latestButton: HTMLButtonElement | null): void {
  if (!page.querySelector('.review-session-head')) return
  const key = activeSessionKey(page)
  if (!key || key === currentSessionKey) return

  currentSessionKey = key
  const saved = sessionPositions.get(key)
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (!document.body.contains(pane) || activeSessionKey(page) !== key) return
    if (saved !== undefined) {
      pane.scrollTop = Math.min(saved, Math.max(0, pane.scrollHeight - pane.clientHeight))
      updateActiveTick(page, pane)
      return
    }
    if (sessionHasRunningTool(page) && latestButton) {
      latestButton.click()
      return
    }
    pane.scrollTop = 0
    updateActiveTick(page, pane)
  }))
}

function bindPage(page: HTMLElement, pane: HTMLElement): void {
  if (!boundPages.has(page)) {
    boundPages.add(page)
    page.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target.closest('.session-item') : null
      if (target) saveReadingPosition(page, pane)
    }, true)
  }

  if (!boundPanes.has(pane)) {
    boundPanes.add(pane)
    pane.addEventListener('scroll', () => {
      saveReadingPosition(page, pane)
      updateActiveTick(page, pane)
    }, { passive: true })
  }
}

function enhanceReview(): void {
  const page = document.querySelector<HTMLElement>('.review-page')
  if (!page) {
    currentSessionKey = ''
    return
  }
  const pane = page.querySelector<HTMLElement>('.review-reader-pane')
  if (!pane) return

  bindPage(page, pane)
  ensureRoundsStayOpen(page)
  const latest = ensureRoundNav(page)
  ensureFourMetrics(page)
  ensureTurnRail(page, pane)
  restoreSessionPosition(page, pane, latest)
}

function scheduleEnhance(): void {
  if (scheduledFrame) return
  scheduledFrame = window.requestAnimationFrame(() => {
    scheduledFrame = 0
    enhanceReview()
  })
}

const root = document.getElementById('root')
if (root) {
  const observer = new MutationObserver(scheduleEnhance)
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'open'] })
  scheduleEnhance()
}
