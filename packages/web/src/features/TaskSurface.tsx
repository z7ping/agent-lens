import { createPortal } from 'react-dom'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type HTMLAttributes,
  type PropsWithChildren,
} from 'react'

export type TaskSurfaceMode = 'review' | 'live' | 'hub' | 'new'

export interface TaskSurfaceProps extends HTMLAttributes<HTMLElement> {
  mode: TaskSurfaceMode
}

interface TaskSurfaceViewValue {
  showUsageDetails: boolean
  setShowUsageDetails(value: boolean): void
}

interface TaskTurnRailItem {
  id: string
  label: string
  error: boolean
  state: string
  element: HTMLElement
}

interface TaskTurnRailPosition {
  left: number
  top: number
  maxHeight: number
}

const TaskSurfaceViewContext = createContext<TaskSurfaceViewValue>({
  showUsageDetails: false,
  setShowUsageDetails: () => undefined,
})

export function useTaskSurfaceView(): TaskSurfaceViewValue {
  return useContext(TaskSurfaceViewContext)
}

function TaskSurfaceViewProvider({ children }: PropsWithChildren) {
  const [showUsageDetails, setShowUsageDetails] = useState(false)
  const value = useMemo(() => ({ showUsageDetails, setShowUsageDetails }), [showUsageDetails])
  return <TaskSurfaceViewContext.Provider value={value}>{children}</TaskSurfaceViewContext.Provider>
}

function setForwardedRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') {
    ref(value)
    return
  }
  if (ref) ref.current = value
}

function scrollViewport(root: HTMLElement, element: HTMLElement): HTMLElement {
  let current: HTMLElement | null = element.parentElement
  while (current && (current === root || root.contains(current))) {
    const style = window.getComputedStyle(current)
    const overflow = `${style.overflowY} ${style.overflow}`
    if (/(auto|scroll|overlay)/.test(overflow)) return current
    if (current === root) break
    current = current.parentElement
  }
  return root
}

function collectTurnRailItems(root: HTMLElement): TaskTurnRailItem[] {
  const result: TaskTurnRailItem[] = []
  const seen = new Set<string>()
  const elements = root.querySelectorAll<HTMLElement>('.virtual-round-shell[data-interaction-id], .task-round[data-interaction-id]')
  for (const element of elements) {
    const id = element.dataset.interactionId?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)

    const round = element.matches('.task-round')
      ? element
      : element.querySelector<HTMLElement>('.task-round[data-interaction-id]')
    const label = element.dataset.roundLabel?.trim()
      || round?.querySelector<HTMLElement>('.task-round-label')?.textContent?.trim()
      || (id.includes('background') ? '后台活动' : `第 ${result.length + 1} 轮`)
    const error = element.dataset.roundError === 'true' || round?.classList.contains('task-round-has-error') === true
    const state = element.dataset.roundState?.trim() || round?.dataset.taskRoundState?.trim() || 'settled'
    result.push({ id, label, error, state, element })
  }
  return result
}

function sameTurnRailItems(left: TaskTurnRailItem[], right: TaskTurnRailItem[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const next = right[index]
    return Boolean(next)
      && item.id === next.id
      && item.label === next.label
      && item.error === next.error
      && item.state === next.state
      && item.element === next.element
  })
}

function activeTurnRailItem(items: TaskTurnRailItem[], anchorY: number): TaskTurnRailItem {
  let low = 0
  let high = items.length - 1
  let candidate = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    const item = items[middle]!
    const top = item.element.getBoundingClientRect().top
    if (top <= anchorY) {
      candidate = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return items[candidate]!
}

/**
 * 任务详情的统一表现宿主。
 *
 * Review / Live / Hub 是 Task Surface 的状态与数据来源，不是不同的产品页面。
 * Task Surface 同时持有跨状态共享的轮次导轨：只要正文使用 TaskRound / VirtualRoundMount，
 * 历史复盘和实时任务就会得到同一套轮次定位、活动态与错误态导航。
 */
export const TaskSurface = forwardRef<HTMLElement, TaskSurfaceProps>(function TaskSurface(
  { mode, className, children, ...props },
  ref,
) {
  const rootRef = useRef<HTMLElement>(null)
  const railItemsRef = useRef<TaskTurnRailItem[]>([])
  const railViewportRef = useRef<HTMLElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const [railItems, setRailItems] = useState<TaskTurnRailItem[]>([])
  const [activeRoundId, setActiveRoundId] = useState('')
  const [railPosition, setRailPosition] = useState<TaskTurnRailPosition | null>(null)
  const classes = ['task-surface', `task-surface-${mode}`, className].filter(Boolean).join(' ')

  const setRoot = useCallback((node: HTMLElement | null) => {
    rootRef.current = node
    setForwardedRef(ref, node)
  }, [ref])

  const updateRailViewport = useCallback(() => {
    const root = rootRef.current
    const items = railItemsRef.current
    if (!root || items.length === 0) {
      setRailPosition(null)
      return
    }

    const viewport = railViewportRef.current ?? scrollViewport(root, items[0]!.element)
    railViewportRef.current = viewport
    const viewportRect = viewport.getBoundingClientRect()
    if (viewportRect.width <= 0 || viewportRect.height <= 0) {
      setRailPosition(null)
      return
    }

    const anchorY = viewportRect.top + Math.min(Math.max(viewportRect.height * .3, 72), 190)
    const active = activeTurnRailItem(items, anchorY)
    setActiveRoundId(current => current === active.id ? current : active.id)

    const nextPosition = {
      left: viewportRect.left + 10,
      top: viewportRect.top + viewportRect.height / 2,
      maxHeight: Math.max(96, viewportRect.height - 24),
    }
    setRailPosition(current => current
      && Math.abs(current.left - nextPosition.left) < .5
      && Math.abs(current.top - nextPosition.top) < .5
      && Math.abs(current.maxHeight - nextPosition.maxHeight) < .5
      ? current
      : nextPosition)
  }, [])

  const scheduleRailViewport = useCallback(() => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      updateRailViewport()
    })
  }, [updateRailViewport])

  const scanRounds = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const next = collectTurnRailItems(root)
    railItemsRef.current = next
    railViewportRef.current = next.length ? scrollViewport(root, next[0]!.element) : null
    setRailItems(current => sameTurnRailItems(current, next) ? current : next)
    scheduleRailViewport()
  }, [scheduleRailViewport])

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof MutationObserver === 'undefined') return
    scanRounds()

    const observer = new MutationObserver(scanRounds)
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-interaction-id', 'data-round-label', 'data-round-error', 'data-round-state', 'data-mounted', 'open'],
    })
    root.addEventListener('scroll', scheduleRailViewport, true)
    window.addEventListener('resize', scheduleRailViewport)
    return () => {
      observer.disconnect()
      root.removeEventListener('scroll', scheduleRailViewport, true)
      window.removeEventListener('resize', scheduleRailViewport)
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      railViewportRef.current = null
    }
  }, [scanRounds, scheduleRailViewport])

  const jumpToRound = (item: TaskTurnRailItem) => {
    const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    item.element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' })
    setActiveRoundId(item.id)
  }

  const rail = railItems.length > 0 && railPosition && typeof document !== 'undefined'
    ? createPortal(
        <nav
          className={`turn-rail task-turn-rail task-turn-rail-${mode}`}
          aria-label="轮次导轨"
          style={{ left: railPosition.left, top: railPosition.top, maxHeight: railPosition.maxHeight }}
        >
          {railItems.map(item => {
            const active = item.id === activeRoundId
            const running = item.state === 'running'
            const tip = `${item.label}${running ? ' · 进行中' : ''}${item.error ? ' · 有错误' : ''}`
            return <button
              key={item.id}
              type="button"
              className={`turn-tick ${active ? 'active' : ''} ${item.error ? 'err' : ''} ${running ? 'running' : ''}`.trim()}
              data-tip={tip}
              aria-label={`跳到${tip}`}
              aria-current={active ? 'step' : undefined}
              onClick={() => jumpToRound(item)}
            ><i/></button>
          })}
        </nav>,
        document.body,
      )
    : null

  return <TaskSurfaceViewProvider>
    <section ref={setRoot} className={classes} data-task-surface-mode={mode} {...props}>{children}</section>
    {rail}
  </TaskSurfaceViewProvider>
})
