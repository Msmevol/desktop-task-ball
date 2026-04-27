import { BrowserWindow } from 'electron'
import type { MainEvent } from '@shared/types'

/** 向所有窗口广播一个事件 */
export function broadcast(event: MainEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send('main-event', event)
    } catch {
      // 窗口已销毁，忽略
    }
  }
}
