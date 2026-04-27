import { useStore } from '../store'
import { api, unwrap } from '../api'

function formatTime(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function NotificationCenter() {
  const {
    notifications,
    refreshNotifications,
    selectRun,
    setTab,
    tasks,
    setToast,
    unreadCount,
    txt
  } = useStore()

  const taskMap = new Map(tasks.map((t) => [t.id, t.name]))

  const onMarkAll = async () => {
    try {
      await unwrap(api.notifications.markAllRead())
      await refreshNotifications()
      setToast(txt('全部通知已标记为已读', 'All notifications marked as read'))
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  const onJumpToRun = async (id: string, runId: string) => {
    await unwrap(api.notifications.markRead(id))
    await refreshNotifications()
    selectRun(runId)
    setTab('runs')
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <h2 className="text-lg font-bold">
          {txt('通知', 'Notifications')}
          {unreadCount > 0 && (
            <span className="ml-2 tag bg-danger/20 text-danger">
              {txt(`${unreadCount} 条未读`, `${unreadCount} unread`)}
            </span>
          )}
        </h2>
        <button className="btn" onClick={onMarkAll} disabled={unreadCount === 0}>
          {txt('全部标为已读', 'Mark All Read')}
        </button>
      </div>

      {notifications.length === 0 ? (
        <div className="empty-state py-12">{txt('暂无通知。', 'No notifications.')}</div>
      ) : (
        <ul className="space-y-1">
          {notifications.map((n) => (
            <li
              key={n.id}
              className={
                'interactive-card p-3.5 cursor-pointer ' +
                (n.read ? 'opacity-60' : '')
              }
              onClick={() => onJumpToRun(n.id, n.runId)}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2">
                  {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-danger" />}
                  <span className="font-medium text-base">{n.title}</span>
                </div>
                <span className="text-sm text-ink-faint font-mono">{formatTime(n.createdAt)}</span>
              </div>
              <div className="text-sm text-ink-dim mb-1">{n.body}</div>
              <div className="text-xs text-ink-faint tracking-wider">
                {taskMap.get(n.taskId) ?? n.taskId}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
