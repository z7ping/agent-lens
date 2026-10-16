import { useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton, UiIcon } from './ui'
import { useIntegrationOrder } from './IntegrationOrderProvider'

/** 排序动作统一交给 IntegrationOrderProvider 持久化；三种列表只负责不同布局。 */
export function useAgentOrderDrag() {
  const [draggedId, setDraggedId] = useState('')
  const { canReorder, move } = useIntegrationOrder()

  const dragProps = (id: string) => ({
    draggable: canReorder(id),
    onDragStart: (event: DragEvent<HTMLDivElement>) => {
      if (!canReorder(id)) { event.preventDefault(); return }
      setDraggedId(id)
      event.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!canReorder(id)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!canReorder(id)) return
      event.preventDefault()
      if (draggedId && draggedId !== id) move(draggedId, id)
      setDraggedId('')
    },
    onDragEnd: () => setDraggedId(''),
  })

  return { draggedId, dragProps, cancelDrag: () => setDraggedId('') }
}

/** 上移/下移统一使用同一禁用边界、图标和无障碍名称。 */
export function AgentOrderActions({ sourceId, label, className }: {
  sourceId: string
  label: string
  className?: string
}) {
  const { t } = useTranslation('agents')
  const { ordered, canReorder, moveBy } = useIntegrationOrder()
  const reorderable = canReorder(sourceId)
  const movable = ordered.filter(id => canReorder(id))
  const index = movable.indexOf(sourceId)

  return <span className={className}>
    <IconButton size="small" disabled={!reorderable || index <= 0}
      aria-label={t('scope.moveUp', { agent: label })}
      onClick={() => moveBy(sourceId, -1)}><UiIcon name="sort-up" size={14}/></IconButton>
    <IconButton size="small" disabled={!reorderable || index < 0 || index === movable.length - 1}
      aria-label={t('scope.moveDown', { agent: label })}
      onClick={() => moveBy(sourceId, 1)}><UiIcon name="sort-down" size={14}/></IconButton>
  </span>
}
