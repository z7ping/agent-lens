import { createContext, forwardRef, useContext, useMemo, useState, type HTMLAttributes, type PropsWithChildren } from 'react'

export type TaskSurfaceMode = 'review' | 'live' | 'hub' | 'new'

export interface TaskSurfaceProps extends HTMLAttributes<HTMLElement> {
  mode: TaskSurfaceMode
}

interface TaskSurfaceViewValue {
  showUsageDetails: boolean
  setShowUsageDetails(value: boolean): void
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

/**
 * 任务详情的统一表现宿主。
 *
 * Review / Live / Hub 是 Task Surface 的状态与数据来源，不是不同的产品页面。
 * 当前先建立稳定宿主边界；后续逐步把 ReviewPage / PiLivePage 内部的 Round、Message、
 * Thinking、Tool 等表现组件迁入此边界，直到删除两套详情树和 CSS 隐藏适配。
 */
export const TaskSurface = forwardRef<HTMLElement, TaskSurfaceProps>(function TaskSurface(
  { mode, className, children, ...props },
  ref,
) {
  const classes = ['task-surface', `task-surface-${mode}`, className].filter(Boolean).join(' ')
  return <TaskSurfaceViewProvider>
    <section ref={ref} className={classes} data-task-surface-mode={mode} {...props}>{children}</section>
  </TaskSurfaceViewProvider>
})
