import type {
  Task,
  TaskInput,
  TaskPatch,
  Run,
  NotificationItem,
  Settings,
  PromptPreview,
  UploadedScript,
  RemoteScriptItem,
  OpencodeStatus,
  PythonInfo,
  OpenAiConnectionTestResult,
  ArgSchemaGenerateResult,
  IpcResult,
  MainEvent
} from '@shared/types'

/** 把 IpcResult<T> 解包：成功返回 data，失败抛出 */
export async function unwrap<T>(p: Promise<IpcResult<T>> | IpcResult<T>): Promise<T> {
  const r = await p
  if (r.ok) return r.data
  throw new Error(r.error)
}

// 对 window.api 做一层类型包装。这里我们信任 preload 的实现，用类型断言
// 把不透明的 unknown Promise 转成真正的 IpcResult<T>。
type Wrap<T> = Promise<IpcResult<T>>

export const api = {
  tasks: {
    list: () => window.api.tasks.list() as Wrap<Task[]>,
    get: (id: string) => window.api.tasks.get(id) as Wrap<Task>,
    create: (input: TaskInput) => window.api.tasks.create(input) as Wrap<Task>,
    update: (id: string, patch: TaskPatch) => window.api.tasks.update(id, patch) as Wrap<Task>,
    delete: (id: string) => window.api.tasks.delete(id) as Wrap<true>,
    run: (id: string, args: Record<string, unknown>) =>
      window.api.tasks.run(id, args) as Wrap<{ runId: string }>
  },
  runs: {
    list: (filter?: { taskId?: string; limit?: number }) =>
      window.api.runs.list(filter) as Wrap<Run[]>,
    get: (id: string) => window.api.runs.get(id) as Wrap<Run>,
    deleteMany: (runIds: string[]) => window.api.runs.deleteMany(runIds) as Wrap<{ deleted: number }>,
    deleteFailed: (taskId?: string) =>
      window.api.runs.deleteFailed(taskId) as Wrap<{ deleted: number }>,
    retryAi: (id: string) => window.api.runs.retryAi(id) as Wrap<Run>,
    cancel: (id: string) =>
      window.api.runs.cancel(id) as Wrap<{ cancelled: boolean; message: string }>,
    openLogFolder: (id: string) => window.api.runs.openLogFolder(id) as Wrap<true>
  },
  notifications: {
    listAll: (limit?: number) =>
      window.api.notifications.listAll(limit) as Wrap<NotificationItem[]>,
    unreadCount: () => window.api.notifications.unreadCount() as Wrap<number>,
    markRead: (id: string) => window.api.notifications.markRead(id) as Wrap<true>,
    markAllRead: () => window.api.notifications.markAllRead() as Wrap<true>
  },
  settings: {
    get: () => window.api.settings.get() as Wrap<Settings>,
    set: (patch: Partial<Settings>) => window.api.settings.set(patch) as Wrap<Settings>,
    testOpenAI: (patch?: Partial<Settings>) =>
      window.api.settings.testOpenAI(patch) as Wrap<OpenAiConnectionTestResult>,
    openTasksFolder: () => window.api.settings.openTasksFolder() as Wrap<true>
  },
  python: {
    check: (pythonPath?: string) => window.api.python.check(pythonPath) as Wrap<PythonInfo>
  },
  prompt: {
    preview: (taskId: string) => window.api.prompt.preview(taskId) as Wrap<PromptPreview>
  },
  scripts: {
    list: () => window.api.scripts.list() as Wrap<string[]>,
    upload: (opts?: { sourcePath?: string; overwrite?: boolean }) =>
      window.api.scripts.upload(opts) as Wrap<UploadedScript | null>,
    generateSchema: (input: { scriptPath: string }) =>
      window.api.scripts.generateSchema(input) as Wrap<ArgSchemaGenerateResult>,
    serverList: () => window.api.scripts.serverList() as Wrap<RemoteScriptItem[]>,
    serverDownload: (input: { fileName: string; overwrite?: boolean }) =>
      window.api.scripts.serverDownload(input) as Wrap<UploadedScript>,
    serverUpload: (input: { scriptPath: string; overwrite?: boolean }) =>
      window.api.scripts.serverUpload(input) as Wrap<{ uploaded: boolean; fileName: string; summary?: string }>
  },
  opencode: {
    status: () => window.api.opencode.status() as Wrap<OpencodeStatus>,
    log: () => window.api.opencode.log() as Wrap<string>,
    restart: () => window.api.opencode.restart() as Wrap<{ baseUrl: string }>,
    stop: () => window.api.opencode.stop() as Wrap<true>
  },
  panel: {
    toggle: () => window.api.panel.toggle() as Wrap<true>,
    show: () => window.api.panel.show() as Wrap<true>,
    hide: () => window.api.panel.hide() as Wrap<true>,
    isMaximized: () => window.api.panel.isMaximized() as Wrap<boolean>,
    toggleMaximize: () => window.api.panel.toggleMaximize() as Wrap<boolean>
  },
  app: {
    quit: () => window.api.app.quit() as Wrap<true>,
    showHelp: () => window.api.app.showHelp() as Wrap<true>,
    getInfo: () =>
      window.api.app.getInfo() as Wrap<{
        name: string
        version: string
        electron: string
        node: string
        platform: string
      }>,
    checkUpdate: () =>
      window.api.app.checkUpdate() as Wrap<{
        hasUpdate: boolean
        currentVersion: string
        latestVersion?: string
        message: string
      }>,
    openProjectReadme: () => window.api.app.openProjectReadme() as Wrap<true>,
    exportConfig: () => window.api.app.exportConfig() as Wrap<{ filePath: string; taskCount: number } | null>,
    importConfig: () =>
      window.api.app.importConfig() as Wrap<
        | {
            filePath: string
            taskCount: number
            created: number
            updated: number
            skipped: number
            warnings: string[]
          }
        | null
      >,
    pickDirectory: () => window.api.app.pickDirectory() as Wrap<string | null>,
    runQuickCommand: (command: string, cwd?: string) =>
      window.api.app.runQuickCommand(command, cwd) as Wrap<true>,
    healthCheck: () =>
      window.api.app.healthCheck() as Wrap<{
        pythonOk: boolean
        pythonInfo: PythonInfo
        opencodeState: string
        opencodeReady: boolean
        tasksTotal: number
        missingScripts: number
      }>
  },
  events: {
    on: (listener: (e: MainEvent) => void) => window.api.events.on(listener)
  }
}
