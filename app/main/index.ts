import { app, BrowserWindow } from 'electron'
import { initDb, closeDb, SettingsRepo } from './db'
import { registerIpc } from './ipc'
import { createBallWindow, createPanelWindow, markQuitting } from './windows'
import { opencode } from './opencode'
import { broadcast } from './events'
import { startScheduler, stopScheduler } from './scheduler'
import { runtimeLog } from './logger'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  runtimeLog.warn('single_instance_lock_failed')
  app.quit()
}

// 把 opencode 的状态变化广播给所有 renderer，UI 可以实时拿到
// (设置页不用轮询也能刷新)
opencode.on('status', (status) => {
  runtimeLog.info('opencode_status', status)
  broadcast({ type: 'opencode:status', status })
})

app
  .whenReady()
  .then(async () => {
    runtimeLog.info('app_ready_start')
    await initDb()
    runtimeLog.info('db_initialized')
    registerIpc()
    runtimeLog.info('ipc_registered')

    // 后台启动 opencode，不阻塞 UI。
    // 失败也不崩主应用，首次调用 AI 时会重新尝试拉起并把错误返回 UI。
    const settings = SettingsRepo.get()
    runtimeLog.info('opencode_autostart_begin', {
      binPath: settings.opencodeBinPath || 'opencode',
      port: settings.opencodePort
    })
    opencode.start(settings.opencodeBinPath || 'opencode', settings.opencodePort).catch((e) => {
      runtimeLog.error('opencode_autostart_failed', (e as Error).message)
      console.error('opencode 自启失败 (首次 AI 调用时会再试):', e.message)
    })

    createBallWindow()
    createPanelWindow()
    runtimeLog.info('windows_created')
    startScheduler()
    runtimeLog.info('scheduler_started')

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createBallWindow()
        createPanelWindow()
      }
    })
  })
  .catch((err) => {
    runtimeLog.error('startup_failed', (err as Error).message)
    console.error('Startup failed:', err)
    app.exit(1)
  })

// before-quit 改成两阶段：第一次进来时阻止默认退出，清理完再 exit
let cleaningUp = false
app.on('before-quit', async (event) => {
  if (cleaningUp) return // 已经在清理，放行这次真退出
  cleaningUp = true
  runtimeLog.info('before_quit_begin')
  event.preventDefault()
  markQuitting()

  try {
    stopScheduler()
    runtimeLog.info('scheduler_stopped')
  } catch (e) {
    runtimeLog.warn('stop_scheduler_failed', (e as Error).message)
    console.warn('stopScheduler failed:', e)
  }
  try {
    closeDb()
    runtimeLog.info('db_closed')
  } catch (e) {
    runtimeLog.warn('close_db_failed', (e as Error).message)
    console.warn('closeDb failed:', e)
  }
  try {
    await opencode.stop()
    runtimeLog.info('opencode_stopped')
  } catch (e) {
    runtimeLog.warn('stop_opencode_failed', (e as Error).message)
    console.warn('opencode.stop failed:', e)
  }

  runtimeLog.info('before_quit_done')
  app.exit(0)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
