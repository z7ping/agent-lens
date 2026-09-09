import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { TaskSurface, type TaskSurfaceMode } from './TaskSurface'

export interface TaskSessionViewProps {
  mode: TaskSurfaceMode
  className?: string
  header?: ReactNode
  children: ReactNode
  composer?: ReactNode
  readerRef?: Ref<HTMLDivElement>
  readerClassName?: string
  documentClassName?: string
  composerClassName?: string
  readerProps?: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'>
}

function classNames(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ')
}

/**
 * Review / Pi Live 共用的会话视图壳层。
 *
 * 页面控制器只提供 Header、Reader 内容和可选 Composer；滚动层级、阅读轴和
 * Composer 插槽由这里统一。Runtime / 分页 / Evidence 等业务状态不得进入本组件。
 */
export function TaskSessionView({
  mode,
  className,
  header,
  children,
  composer,
  readerRef,
  readerClassName,
  documentClassName,
  composerClassName,
  readerProps,
}: TaskSessionViewProps) {
  return <TaskSurface mode={mode} className={classNames('task-session-view', className)}>
    {header}
    <div ref={readerRef} className={classNames('task-session-reader', readerClassName)} {...readerProps}>
      <div className={classNames('task-session-document', documentClassName)}>{children}</div>
    </div>
    {composer !== undefined && composer !== null
      ? <div className={classNames('task-session-composer', composerClassName)}>{composer}</div>
      : null}
  </TaskSurface>
}
