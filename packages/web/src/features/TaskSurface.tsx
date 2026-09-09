import { createPortal } from 'react-dom'
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from 'react'
import { IconButton, UiIcon } from '../components/ui'

export type TaskSurfaceMode = 'review' | 'live' | 'hub' | 'new'

export interface TaskBoundaryNavigation {
  startDisabled?: boolean
  endDisabled?: boolean
  onStart(): void | Promise<void>
  onEnd(): void | Promise<void>
}

export interface TaskSurfaceProps extends HTMLAttributes<HTMLElement> {
  mode: TaskSurfaceMode
  boundaryNavigation?: TaskBoundaryNavigation
}

interface TaskSurfaceViewValue {
  showUsageDetails: boolean
  setShowUsageDetails(value: boolean): void
}

interface TaskTurnRailItem {
  id: string
  semanticId: string
  label: string
  preview: string
  error: boolean
  state: string
  element: HTMLElement
}

interface TaskTurnRailPosition {
  left: number
  top: number
  maxHeight: number
  boundaryBottom: number
  boundaryLeft: number
}

interface RailFrameRect {
  left: number
  top: number
  width: number
  height: number
}

type SessionSlotElement = ReactElement<{ className?: string; children?: ReactNode }>

const TaskSurfaceViewContext = createContext<TaskSurfaceViewValue>({
  showUsageDetails: false,
  setShowUsageDetails: () => undefined,
})

const sessionReaderHooks = new Set(['review-reader-pane', 'pi-live-reader'])
const sessionDocumentHooks = new Set(['review-reader', 'pi-live-document'])
const sessionComposerHooks = new Set(['pi-live-compose-wrap'])

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

function classTokens(value: string | undefined): string[] {
  return value?.split(/\s+/).filter(Boolean) ?? []
}

function hasSessionHook(element: SessionSlotElement, hooks: Set<string>): boolean {
  return classTokens(element.props.className).some(value => hooks.has(value))
}

function withSessionClass(element: SessionSlotElement, className: string, children = element.props.children): SessionSlotElement {
  const classes = classTokens(element.props.className)
  if (!classes.includes(className)) classes.unshift(className)
  return cloneElement(element, { className: classes.join(' ') }, children)
}

function normalizeSessionReader(element: SessionSlotElement): SessionSlotElement {
  const content = Children.map(element.props.children, child => {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return child
    const candidate = child as SessionSlotElement
    return hasSessionHook(candidate, sessionDocumentHooks)
      ? withSessionClass(candidate, 'task-session-document')
      : child
  })
  return withSessionClass(element, 'task-session-reader', content)
}

function normalizeSessionChildren(children: ReactNode, sessionMode: boolean): ReactNode {
  if (!sessionMode) return children
  return Children.map(children, child => {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return child
    const candidate = child as SessionSlotElement
    if (hasSessionHook(candidate, sessionReaderHooks)) return normalizeSessionReader(candidate)
    if (hasSessionHook(candidate, sessionComposerHooks)) return withSessionClass(candidate, 'task-session-composer')
    return child
  })
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

function sessionRailFrame(root: HTMLElement, fallback: DOMRect): RailFrameRect {
  const surface = root.getBoundingClientRect()
  const header = Array.from(root.children).find(child => child instanceof HTMLElement && child.classList.contains('task-header'))
  const headerRect = header instanceof HTMLElement ? header.getBoundingClientRect() : null
  const top = headerRect && headerRect.height > 0 ? Math.max(surface.top, headerRect.bottom) : surface.top
  const height = Math.max(0, surface.bottom - top)
  if (surface.width <= 0 || height <= 0) {
    return { left: fallback.left, top: fallback.top, width: fallback.width, height: fallback.height }
  }
  return { left: surface.left, top, width: surface.width, height }
}

function sessionBoundaryPosition(root: HTMLElement, railFrame: RailFrameRect, fallback: DOMRect) {
  const documentRect = root.querySelector<HTMLElement>('.task-session-document')?.getBoundingClientRect()
  const documentRight = documentRect && documentRect.width > 0 ? documentRect.right : fallback.right
  return {
    bottom: Math.max(16, window.innerHeight - (railFrame.top + railFrame.height) + 16),
    left: Math.min(window.innerWidth - 58, Math.max(16, documentRight + 12)),
  }
}

function compactRailPreview(value: string | undefined, max = 86): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function mergeRoundState(current: string, next: string): string {
  if (current === 'running' || next === 'running') return 'running'
  if (current === 'stopped' || next === 'stopped') return 'stopped'
  return next || current || 'settled'
}

function collectTurnRailItems(root: HTMLElement): TaskTurnRailItem[] {
  const result: TaskTurnRailItem[] = []
  const bySemanticId = new Map<string, TaskTurnRailItem>()
  const elements = root.querySelectorAll<HTMLElement>('.virtual-round-shell[data-interaction-id], .task-round[data-interaction-id]')
  for (const element of elements) {
    if (element.closest('.task-surface') !== root) continue

    const renderId = element.dataset.interactionId?.trim()
    if (!renderId) continue

    const round = element.matches('.task-round')
      ? element
      : element.querySelector<HTMLElement>('.task-round[data-interaction-id]')
    const semanticId = element.dataset.roundSemanticId?.trim()
      || round?.dataset.roundSemanticId?.trim()
      || renderId
    const label = element.dataset.roundLabel?.trim()
      || round?.querySelector<HTMLElement>('.task-round-label')?.textContent?.trim()
      || (semanticId.includes('background') ? '后台活动' : `第 ${result.length + 1} 轮`)
    const preview = compactRailPreview(
      element.dataset.roundPreview
      || round?.dataset.roundPreview
      || round?.querySelector<HTMLElement>('.task-round-preview')?.textContent
      || round?.querySelector<HTMLElement>('[data-task-message-role="user"] .markdown-surface')?.textContent
      || undefined,
    )
    const error = element.dataset.roundError === 'true' || round?.classList.contains('task-round-has-error') === true
    const state = element.dataset.roundState?.trim() || round?.dataset.taskRoundState?.trim() || 'settled'

    const existing = bySemanticId.get(semanticId)
    if (existing) {
      existing.error = existing.error || error
      existing.state = mergeRoundState(existing.state, state)
      if (!existing.preview && preview) existing.preview = preview
      continue
    }

    const item = { id: semanticId, semanticId, label, preview, error, state, element }
    bySemanticId.set(semanticId, item)
    result.push(item)
  }
  return result
}

function stabilizeTurnRailItemIds(previous: TaskTurnRailItem[], next: TaskTurnRailItem[]): TaskTurnRailItem[] {
  if (!previous.length || !next.length) return next

  const previousBySemanticId = new Map(previous.map(item => [item.semanticId, item] as const))
  const previousByElement = new Map(previous.map(item => [item.element, item] as const))
  const resolved = next.map(item => {
    const sameSemantic = previousBySemanticId.get(item.semanticId)
    if (sameSemantic) return { ...item, id: sameSemantic.id }
    const sameElement = previousByElement.get(item.element)
    if (sameElement) return { ...item, id: sameElement.id }
    return item
  })

  if (previous.length !== resolved.length) return resolved
  const changed = resolved.flatMap((item, index) => {
    const before = previous[index]
    if (!before || before.semanticId === item.semanticId || before.element === item.element) return []
    return [{ index, before, item }]
  })
  if (changed.length !== 1) return resolved

  const transition = changed[0]!
  const samePreview = Boolean(transition.before.preview && transition.before.preview === transition.item.preview)
  const sameLabel = transition.before.label === transition.item.label
  if (!samePreview && !sameLabel) return resolved
  resolved[transition.index] = { ...transition.item, id: transition.before.id }
  return resolved
}

function sameTurnRailItems(left: TaskTurnRailItem[], right: TaskTurnRailItem[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const next = right[index]
    return Boolean(next)
      && item.id === next.id
      && item.semanticId === next.semanticId
      && item.label === next.label
      && item.preview === next.preview
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
 * Review / Live 同属一个 Session View；页面仅保留控制器与能力差异。
 * TaskSurface 持有统一 Reader/Document/Composer 槽位、语义轮次导轨与边界导航。
 */
export const TaskSurface = forwardRef<HTMLElement, TaskSurfaceProps>(function TaskSurface(
  { mode, className, children, boundaryNavigation, ...props },
  ref,
) {
  const rootRef = useRef<HTMLElement>(null)
  const railItemsRef = useRef<TaskTurnRailItem[]>([])
  const railViewportRef = useRef<HTMLElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const [railItems, setRailItems] = useState<TaskTurnRailItem[]>([])
  const [activeRoundId, setActiveRoundId] = useState('')
  const [railPosition, setRailPosition] = useState<TaskTurnRailPosition | null>(null)
  const sessionMode = mode === 'review' || mode === 'live'
  const classes = ['task-surface', sessionMode ? 'task-session-view' : '', `task-surface-${mode}`, className].filter(Boolean).join(' ')
  const sessionChildren = normalizeSessionChildren(children, sessionMode)

  const setRoot = useCallback((node: HTMLElement | null) => {
    rootRef.current = node
    setForwardedRef(ref, node)
  }, [ref])

  const updateRailViewport = useCallback(() => {
    const root = rootRef.current
    if (!root) {
      setRailPosition(null)
      return
    }

    const items = railItemsRef.current
    const viewport = railViewportRef.current
      ?? (items.length ? scrollViewport(root, items[0]!.element) : root.querySelector<HTMLElement>('.task-session-reader'))
    railViewportRef.current = viewport
    if (!viewport) {
      setRailPosition(null)
      return
    }

    const viewportRect = viewport.getBoundingClientRect()
    if (viewportRect.width <= 0 || viewportRect.height <= 0) {
      setRailPosition(null)
      return
    }

    if (items.length) {
      const anchorY = viewportRect.top + Math.min(Math.max(viewportRect.height * .3, 72), 190)
      const active = activeTurnRailItem(items, anchorY)
      setActiveRoundId(current => current === active.id ? current : active.id)
    }

    const railFrame = sessionMode ? sessionRailFrame(root, viewportRect) : viewportRect
    const boundary = sessionBoundaryPosition(root, railFrame, viewportRect)
    const nextPosition = {
      left: railFrame.left + 10,
      top: railFrame.top + railFrame.height / 2,
      maxHeight: Math.max(96, railFrame.height - 24),
      boundaryBottom: boundary.bottom,
      boundaryLeft: boundary.left,
    }
    setRailPosition(current => current
      && Math.abs(current.left - nextPosition.left) < .5
      && Math.abs(current.top - nextPosition.top) < .5
      && Math.abs(current.maxHeight - nextPosition.maxHeight) < .5
      && Math.abs(current.boundaryBottom - nextPosition.boundaryBottom) < .5
      && Math.abs(current.boundaryLeft - nextPosition.boundaryLeft) < .5
      ? current
      : nextPosition)
  }, [sessionMode])

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
    const collected = collectTurnRailItems(root)
    const next = stabilizeTurnRailItemIds(railItemsRef.current, collected)
    railItemsRef.current = next
    railViewportRef.current = next.length
      ? scrollViewport(root, next[0]!.element)
      : root.querySelector<HTMLElement>('.task-session-reader')
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
      attributeFilter: ['class', 'data-interaction-id', 'data-round-semantic-id', 'data-round-label', 'data-round-preview', 'data-round-error', 'data-round-state', 'data-mounted', 'open'],
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

  const jumpToBoundary = (boundary: 'start' | 'end') => {
    const viewport = railViewportRef.current
    if (!viewport) return
    const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    viewport.scrollTo({
      top: boundary === 'start' ? 0 : viewport.scrollHeight,
      behavior: reducedMotion ? 'auto' : 'smooth',
    })
    scheduleRailViewport()
  }

  const resolvedBoundaryNavigation: TaskBoundaryNavigation | undefined = boundaryNavigation
    ?? (mode === 'live'
      ? {
          onStart: () => jumpToBoundary('start'),
          onEnd: () => jumpToBoundary('end'),
        }
      : undefined)

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
            const tip = [item.label, item.preview, running ? '进行中' : '', item.error ? '有错误' : ''].filter(Boolean).join(' · ')
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

  const boundaryNav = railItems.length > 0 && resolvedBoundaryNavigation && railPosition && typeof document !== 'undefined'
    ? createPortal(
        <nav
          className="task-boundary-nav"
          aria-label="会话边界导航"
          style={{ bottom: railPosition.boundaryBottom, left: railPosition.boundaryLeft }}
        >
          <IconButton
            title="跳到开头"
            aria-label="跳到开头"
            disabled={resolvedBoundaryNavigation.startDisabled}
            onClick={() => void resolvedBoundaryNavigation.onStart()}
          >
            <UiIcon name="arrow-big-up" size={20} strokeWidth={2}/>
          </IconButton>
          <IconButton
            className="task-boundary-latest"
            variant="primary"
            title="跳到最新"
            aria-label="跳到最新"
            disabled={resolvedBoundaryNavigation.endDisabled}
            onClick={() => void resolvedBoundaryNavigation.onEnd()}
          >
            <UiIcon name="arrow-big-down" size={20} strokeWidth={2}/>
          </IconButton>
        </nav>,
        document.body,
      )
    : null

  return <TaskSurfaceViewProvider>
    <section
      ref={setRoot}
      className={classes}
      data-task-surface-mode={mode}
      data-task-session-interactive={sessionMode ? (mode === 'live' ? 'true' : 'false') : undefined}
      {...props}
    >{sessionChildren}</section>
    {rail}
    {boundaryNav}
  </TaskSurfaceViewProvider>
})