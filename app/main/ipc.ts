import { app, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { TasksRepo, RunsRepo, NotificationsRepo, SettingsRepo } from './db'
import { runTask, retryAi, cancelRun } from './runner'
import { buildPreview } from './prompt'
import { uploadScript, listScripts } from './scripts'
import { generateArgSchemaForScript } from './arg-schema'
import { listRemoteScripts, downloadRemoteScript, uploadScriptToRemote } from './script-server-client'
import {
  getBallBounds,
  hidePanel,
  isPanelMaximized,
  snapBallToEdge,
  executeQuickCommand,
  setBallPosition,
  showHelpWindow,
  showPanel,
  togglePanelMaximize,
  togglePanel
} from './windows'
import { paths } from './paths'
import { opencode } from './opencode'
import { checkPython } from './python'
import { buildImportPlan } from './config-transfer'
import { testOpenAiConnection } from './ai'
import type { TaskInput, TaskPatch, Settings } from '@shared/types'
import { runtimeLog } from './logger'

function ok<T>(data: T) {
  return { ok: true as const, data }
}
function fail(e: unknown) {
  return { ok: false as const, error: (e as Error).message ?? String(e) }
}

export function registerIpc(): void {
  // ---- tasks ----
  ipcMain.handle('tasks:list', () => {
    try {
      return ok(TasksRepo.list())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('tasks:get', (_e, id: string) => {
    try {
      const t = TasksRepo.get(id)
      if (!t) throw new Error(`任务不存在：${id}`)
      return ok(t)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('tasks:create', (_e, input: TaskInput) => {
    try {
      return ok(TasksRepo.create(input))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('tasks:update', (_e, id: string, patch: TaskPatch) => {
    try {
      const t = TasksRepo.update(id, patch)
      if (!t) throw new Error(`任务不存在：${id}`)
      return ok(t)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('tasks:delete', (_e, id: string) => {
    try {
      TasksRepo.delete(id)
      return ok(true)
    } catch (e) {
      return fail(e)
    }
  })

  // runTask 现在同步返回 runId，执行在后台进行
  ipcMain.handle('tasks:run', (_e, taskId: string, args: Record<string, unknown>) => {
    try {
      runtimeLog.info('ipc_tasks_run', { taskId, argKeys: Object.keys(args ?? {}) })
      return ok(runTask(taskId, args))
    } catch (e) {
      runtimeLog.warn('ipc_tasks_run_failed', { taskId, error: (e as Error).message })
      return fail(e)
    }
  })

  // ---- runs ----
  ipcMain.handle('runs:list', (_e, filter?: { taskId?: string; limit?: number }) => {
    try {
      return ok(RunsRepo.list(filter ?? {}))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('runs:get', (_e, runId: string) => {
    try {
      const r = RunsRepo.get(runId)
      if (!r) throw new Error(`运行记录不存在：${runId}`)
      return ok(r)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('runs:deleteMany', (_e, runIds: string[]) => {
    try {
      const deleted = RunsRepo.deleteMany(Array.isArray(runIds) ? runIds : [])
      return ok({ deleted })
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('runs:deleteFailed', (_e, taskId?: string) => {
    try {
      const deleted = RunsRepo.deleteFailed(taskId && taskId.trim() ? taskId : undefined)
      return ok({ deleted })
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('runs:retryAi', async (_e, runId: string) => {
    try {
      runtimeLog.info('ipc_runs_retry_ai', { runId })
      return ok(await retryAi(runId))
    } catch (e) {
      runtimeLog.warn('ipc_runs_retry_ai_failed', { runId, error: (e as Error).message })
      return fail(e)
    }
  })

  ipcMain.handle('runs:cancel', (_e, runId: string) => {
    try {
      runtimeLog.info('ipc_runs_cancel', { runId })
      return ok(cancelRun(runId))
    } catch (e) {
      runtimeLog.warn('ipc_runs_cancel_failed', { runId, error: (e as Error).message })
      return fail(e)
    }
  })

  ipcMain.handle('runs:openLogFolder', async (_e, runId: string) => {
    try {
      const run = RunsRepo.get(runId)
      if (!run) throw new Error(`运行记录不存在：${runId}`)
      const dir = path.join(paths().runsDir, runId)
      await shell.openPath(dir)
      return ok(true)
    } catch (e) {
      return fail(e)
    }
  })

  // ---- notifications ----
  ipcMain.handle('notifications:listAll', (_e, limit?: number) => {
    try {
      return ok(NotificationsRepo.listAll(limit))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('notifications:unreadCount', () => {
    try {
      return ok(NotificationsRepo.unreadCount())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('notifications:markRead', (_e, id: string) => {
    try {
      NotificationsRepo.markRead(id)
      return ok(true)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('notifications:markAllRead', () => {
    try {
      NotificationsRepo.markAllRead()
      return ok(true)
    } catch (e) {
      return fail(e)
    }
  })

  // ---- settings ----
  ipcMain.handle('settings:get', () => {
    try {
      return ok(SettingsRepo.get())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    try {
      runtimeLog.info('ipc_settings_set', { keys: Object.keys(patch ?? {}) })
      return ok(SettingsRepo.set(patch))
    } catch (e) {
      runtimeLog.warn('ipc_settings_set_failed', { error: (e as Error).message })
      return fail(e)
    }
  })

  ipcMain.handle('settings:testOpenAI', async (_e, patch?: Partial<Settings>) => {
    try {
      const merged = { ...SettingsRepo.get(), ...(patch ?? {}) }
      const result = await testOpenAiConnection(merged)
      return ok(result)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('python:check', async (_e, pythonPath?: string) => {
    try {
      const settings = SettingsRepo.get()
      const p = pythonPath && pythonPath.trim() ? pythonPath : settings.pythonPath
      const info = await checkPython(p, false)
      return ok(info)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('settings:openTasksFolder', async () => {
    try {
      await shell.openPath(paths().tasksDir)
      return ok(true)
    } catch (e) {
      return fail(e)
    }
  })

  // ---- prompt preview ----
  ipcMain.handle('prompt:preview', (_e, taskId: string) => {
    try {
      const task = TasksRepo.get(taskId)
      if (!task) throw new Error(`任务不存在：${taskId}`)
      const latest = RunsRepo.latestForTask(taskId)
      return ok(buildPreview(task, latest))
    } catch (e) {
      return fail(e)
    }
  })

  // ---- scripts (上传/列表) ----
  ipcMain.handle('scripts:list', () => {
    try {
      return ok(listScripts())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(
    'scripts:upload',
    async (_e, opts: { sourcePath?: string; overwrite?: boolean } = {}) => {
      try {
        const r = await uploadScript(opts)
        return ok(r)
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle('scripts:generateSchema', async (_e, input: { scriptPath: string }) => {
    try {
      const settings = SettingsRepo.get()
      return ok(await generateArgSchemaForScript(String(input?.scriptPath ?? ''), settings))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('scripts:server:list', async () => {
    try {
      const settings = SettingsRepo.get()
      return ok(await listRemoteScripts(settings))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(
    'scripts:server:download',
    async (_e, input: { fileName: string; overwrite?: boolean }) => {
      try {
        const settings = SettingsRepo.get()
        return ok(await downloadRemoteScript(settings, input))
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    'scripts:server:upload',
    async (_e, input: { scriptPath: string; overwrite?: boolean }) => {
      try {
        const settings = SettingsRepo.get()
        return ok(await uploadScriptToRemote(settings, input))
      } catch (e) {
        return fail(e)
      }
    }
  )

  // ---- opencode (子进程控制) ----
  ipcMain.handle('opencode:status', () => {
    try {
      return ok(opencode.getStatus())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('opencode:log', () => {
    try {
      return ok(opencode.getRecentLog())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('opencode:restart', async () => {
    try {
      const s = SettingsRepo.get()
      runtimeLog.info('ipc_opencode_restart', { binPath: s.opencodeBinPath || 'opencode', port: s.opencodePort })
      const url = await opencode.restart(s.opencodeBinPath || 'opencode', s.opencodePort)
      return ok({ baseUrl: url })
    } catch (e) {
      runtimeLog.error('ipc_opencode_restart_failed', { error: (e as Error).message })
      return fail(e)
    }
  })

  ipcMain.handle('opencode:stop', async () => {
    try {
      runtimeLog.info('ipc_opencode_stop')
      await opencode.stop()
      return ok(true)
    } catch (e) {
      runtimeLog.error('ipc_opencode_stop_failed', { error: (e as Error).message })
      return fail(e)
    }
  })

  // ---- panel / ball control ----
  ipcMain.handle('panel:toggle', () => {
    togglePanel()
    return ok(true)
  })
  ipcMain.handle('panel:show', () => {
    showPanel()
    return ok(true)
  })
  ipcMain.handle('panel:hide', () => {
    hidePanel()
    return ok(true)
  })
  ipcMain.handle('panel:isMaximized', () => {
    return ok(isPanelMaximized())
  })
  ipcMain.handle('panel:toggleMaximize', () => {
    return ok(togglePanelMaximize())
  })
  ipcMain.handle('ball:getBounds', () => {
    return ok(getBallBounds())
  })
  ipcMain.handle('ball:setPosition', (_e, x: number, y: number) => {
    setBallPosition(x, y)
    return ok(true)
  })
  ipcMain.handle('ball:snapToEdge', () => {
    snapBallToEdge()
    return ok(true)
  })

  ipcMain.handle('app:quit', () => {
    app.quit()
    return ok(true)
  })

  ipcMain.handle('app:showHelp', () => {
    showHelpWindow()
    return ok(true)
  })

  ipcMain.handle('app:getInfo', () => {
    return ok({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`
    })
  })

  ipcMain.handle('app:openProjectReadme', async () => {
    const readme = path.join(process.cwd(), 'README.md')
    await shell.openPath(readme)
    return ok(true)
  })

  ipcMain.handle('app:checkUpdate', () => {
    const pkgPath = path.join(process.cwd(), 'package.json')
    let localVersion = app.getVersion()
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }
        if (pkg.version) localVersion = pkg.version
      } catch {
        /* ignore */
      }
    }
    return ok({
      hasUpdate: false,
      currentVersion: localVersion,
      latestVersion: localVersion,
      message:
        `当前版本 ${localVersion}。\n` +
        '暂未配置在线更新源（Auto Updater）。你可以在发布页或 README 查看更新说明。'
    })
  })

  ipcMain.handle('app:pickDirectory', async () => {
    const pick = await dialog.showOpenDialog({
      title: '选择命令执行目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (pick.canceled || pick.filePaths.length === 0) return ok(null)
    return ok(pick.filePaths[0])
  })

  ipcMain.handle('app:runQuickCommand', async (_e, command: string, cwd?: string) => {
    const cmd = String(command ?? '').trim()
    if (!cmd) return fail(new Error('命令不能为空'))
    const targetCwd = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd()
    try {
      runtimeLog.info('ipc_run_quick_command', { cwd: targetCwd, command: cmd })
      executeQuickCommand(cmd, targetCwd)
      return ok(true)
    } catch (e) {
      runtimeLog.warn('ipc_run_quick_command_failed', {
        cwd: targetCwd,
        command: cmd,
        error: (e as Error).message
      })
      return fail(e)
    }
  })

  ipcMain.handle('app:exportConfig', async () => {
    const pick = await dialog.showSaveDialog({
      title: '导出任务配置',
      defaultPath: `task-ball-export-${Date.now()}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (pick.canceled || !pick.filePath) return ok(null)
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks: TasksRepo.list().map((t) => ({
        name: t.name,
        tag: t.tag,
        description: t.description,
        scriptPath: t.scriptPath,
        argsSchema: t.argsSchema,
        timeoutSec: t.timeoutSec,
        scheduleEnabled: t.scheduleEnabled,
        scheduleEveryMin: t.scheduleEveryMin,
        retryCount: t.retryCount,
        retryDelaySec: t.retryDelaySec,
        notifyOnFailure: t.notifyOnFailure,
        notifyOnTimeout: t.notifyOnTimeout,
        aiEnabled: t.aiEnabled,
        aiProvider: t.aiProvider,
        failureAiEnabled: t.failureAiEnabled,
        failureAiPrompt: t.failureAiPrompt,
        systemPrompt: t.systemPrompt,
        userPromptTemplate: t.userPromptTemplate,
        notifyEnabled: t.notifyEnabled
      })),
      settings: SettingsRepo.get()
    }
    fs.writeFileSync(pick.filePath, JSON.stringify(data, null, 2), 'utf8')
    return ok({ filePath: pick.filePath, taskCount: data.tasks.length })
  })

  ipcMain.handle('app:importConfig', async () => {
    const pick = await dialog.showOpenDialog({
      title: '导入任务配置',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (pick.canceled || pick.filePaths.length === 0) return ok(null)
    const p = pick.filePaths[0]
    const text = fs.readFileSync(p, 'utf8')
    const json = JSON.parse(text) as { tasks?: unknown; settings?: unknown }
    const plan = buildImportPlan(json)
    let created = 0
    let updated = 0
    if (plan.tasks.length > 0) {
      const existing = TasksRepo.list()
      for (const t of plan.tasks) {
        const hit = existing.find((x) => x.name === t.name && x.scriptPath === t.scriptPath)
        if (hit) {
          TasksRepo.update(hit.id, t)
          updated++
        } else {
          TasksRepo.create(t)
          created++
        }
      }
    }
    if (Object.keys(plan.settings).length > 0) SettingsRepo.set(plan.settings)
    return ok({
      filePath: p,
      taskCount: created + updated,
      created,
      updated,
      skipped: plan.skipped,
      warnings: plan.warnings
    })
  })

  ipcMain.handle('app:healthCheck', async () => {
    const s = SettingsRepo.get()
    const py = await checkPython(s.pythonPath, false)
    const oc = opencode.getStatus()
    const scripts = listScripts()
    const tasks = TasksRepo.list()
    const missingScripts = tasks.filter((t) => !scripts.includes(t.scriptPath)).length
    return ok({
      pythonOk: py.ok,
      pythonInfo: py,
      opencodeState: oc.state,
      opencodeReady: oc.state === 'ready',
      tasksTotal: tasks.length,
      missingScripts
    })
  })
}
