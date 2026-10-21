import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, IconButton, Popover, UiIcon } from '../components/ui'
import { taskNotifications, useTaskNotifications, type TaskNotification, type TaskNotificationLevel } from './task-notifications'

function notificationIcon(level: TaskNotificationLevel) {
  if (level === 'success') return 'status-success' as const
  if (level === 'error') return 'status-error' as const
  if (level === 'warning' || level === 'action') return 'alert' as const
  return 'info' as const
}

function notificationHref(item: TaskNotification) {
  return `/review/live/${encodeURIComponent(item.liveId)}/${encodeURIComponent(item.runtimeSessionId)}`
}

export function TaskNotificationBell() {
  const { t } = useTranslation('task')
  const { items } = useTaskNotifications()
  const navigate = useNavigate()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const unread = items.filter(item => !item.read).length
  const visible = unreadOnly ? items.filter(item => !item.read) : items

  const openItem = (item: TaskNotification) => {
    taskNotifications.markRead(item.id)
    setOpen(false)
    navigate(notificationHref(item))
  }

  return <div className="task-notification-bell">
    <IconButton
      ref={anchorRef}
      size="small"
      className="task-notification-trigger"
      aria-label={t('notifications.bell', { count: unread })}
      aria-expanded={open}
      title={t('notifications.bell', { count: unread })}
      onClick={() => setOpen(value => !value)}
    >
      <UiIcon name="bell" size={16}/>
      {unread > 0 && <span className="task-notification-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
    </IconButton>
    <Popover
      open={open}
      anchorRef={anchorRef}
      onClose={() => setOpen(false)}
      placement="right-start"
      className="task-notification-popover"
    >
      <div className="task-notification-panel">
        <header className="task-notification-heading">
          <strong>{t('notifications.title')}</strong>
          {unread > 0 && <Button size="small" variant="quiet" onClick={() => taskNotifications.markAllRead()}>
            {t('notifications.markAllRead')}
          </Button>}
        </header>
        <div className="task-notification-tabs">
          <Button size="small" variant="quiet" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>{t('notifications.all')}</Button>
          <Button size="small" variant="quiet" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>{t('notifications.unread', { count: unread })}</Button>
        </div>
        <div className="task-notification-items" role="list">
          {!visible.length && <p className="task-notification-empty">{t('notifications.empty')}</p>}
          {visible.map(item => <div role="listitem" key={item.id}>
            <button type="button" className={`task-notification-item is-${item.level} ${item.read ? 'is-read' : 'is-unread'}`}
              onClick={() => openItem(item)}>
              <UiIcon name={notificationIcon(item.level)} size={16}/>
              <span className="task-notification-copy">
                <span className="task-notification-title">{item.liveId} · {item.title || t(`notifications.level.${item.level}`)}</span>
                <span className="task-notification-message">{item.message}</span>
                <time dateTime={item.receivedAt}>{new Date(item.receivedAt).toLocaleString()}</time>
              </span>
              {!item.read && <span className="task-notification-unread-dot" aria-label={t('notifications.unreadDot')}/>}
            </button>
          </div>)}
        </div>
      </div>
    </Popover>
  </div>
}

export function TaskNotificationBanner() {
  const { t } = useTranslation('task')
  const { items, bannerId } = useTaskNotifications()
  const navigate = useNavigate()
  const item = items.find(item => item.id === bannerId)
  useEffect(() => {
    if (!item || item.level !== 'success') return
    const timer = window.setTimeout(() => taskNotifications.dismissBanner(item.id), 5_000)
    return () => window.clearTimeout(timer)
  }, [item?.id, item?.level])
  if (!item) return null
  const openItem = () => {
    taskNotifications.markRead(item.id)
    taskNotifications.dismissBanner(item.id)
    navigate(notificationHref(item))
  }
  return <div className={`task-notification-banner is-${item.level}`} role="status" aria-live="polite">
    <UiIcon name={notificationIcon(item.level)} size={18}/>
    <div className="task-notification-banner-copy">
      <strong>{item.liveId} · {item.title || t(`notifications.level.${item.level}`)}</strong>
      <span>{item.message}</span>
    </div>
    <Button size="small" variant="quiet" onClick={openItem}>{t('notifications.viewSession')}</Button>
    <IconButton size="small" aria-label={t('notifications.dismiss')} title={t('notifications.dismiss')} onClick={() => taskNotifications.dismissBanner(item.id)}>
      <UiIcon name="close" size={16}/>
    </IconButton>
  </div>
}
