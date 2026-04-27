import { Notification } from 'electron'

export function showNotification(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent: false })
    n.show()
  } catch (e) {
    console.warn('通知发送失败:', e)
  }
}
