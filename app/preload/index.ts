import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type { MainEvent } from '@shared/types'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>
const invoke: Invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

const api = {
  tasks: {
    list: () => invoke('tasks:list'),
    get: (id: string) => invoke('tasks:get', id),
    create: (input: unknown) => invoke('tasks:create', input),
    update: (id: string, patch: unknown) => invoke('tasks:update', id, patch),
    delete: (id: string) => invoke('tasks:delete', id),
    run: (id: string, args: unknown) => invoke('tasks:run', id, args)
  },
  runs: {
    list: (filter?: unknown) => invoke('runs:list', filter),
    get: (id: string) => invoke('runs:get', id),
    deleteMany: (runIds: string[]) => invoke('runs:deleteMany', runIds),
    deleteFailed: (taskId?: string) => invoke('runs:deleteFailed', taskId),
    retryAi: (id: string) => invoke('runs:retryAi', id),
    cancel: (id: string) => invoke('runs:cancel', id),
    openLogFolder: (id: string) => invoke('runs:openLogFolder', id)
  },
  notifications: {
    listAll: (limit?: number) => invoke('notifications:listAll', limit),
    unreadCount: () => invoke('notifications:unreadCount'),
    markRead: (id: string) => invoke('notifications:markRead', id),
    markAllRead: () => invoke('notifications:markAllRead')
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch: unknown) => invoke('settings:set', patch),
    testOpenAI: (patch?: unknown) => invoke('settings:testOpenAI', patch),
    openTasksFolder: () => invoke('settings:openTasksFolder')
  },
  python: {
    check: (pythonPath?: string) => invoke('python:check', pythonPath)
  },
  prompt: {
    preview: (taskId: string) => invoke('prompt:preview', taskId)
  },
  scripts: {
    list: () => invoke('scripts:list'),
    upload: (opts?: { sourcePath?: string; overwrite?: boolean }) =>
      invoke('scripts:upload', opts ?? {}),
    generateSchema: (input: { scriptPath: string }) =>
      invoke('scripts:generateSchema', input),
    serverList: () => invoke('scripts:server:list'),
    serverDownload: (input: { fileName: string; overwrite?: boolean }) =>
      invoke('scripts:server:download', input),
    serverUpload: (input: { scriptPath: string; overwrite?: boolean }) =>
      invoke('scripts:server:upload', input)
  },
  opencode: {
    status: () => invoke('opencode:status'),
    log: () => invoke('opencode:log'),
    restart: () => invoke('opencode:restart'),
    stop: () => invoke('opencode:stop')
  },
  panel: {
    toggle: () => invoke('panel:toggle'),
    show: () => invoke('panel:show'),
    hide: () => invoke('panel:hide'),
    isMaximized: () => invoke('panel:isMaximized'),
    toggleMaximize: () => invoke('panel:toggleMaximize')
  },
  ball: {
    getBounds: () => invoke('ball:getBounds'),
    setPosition: (x: number, y: number) => invoke('ball:setPosition', x, y),
    snapToEdge: () => invoke('ball:snapToEdge')
  },
  app: {
    quit: () => invoke('app:quit'),
    showHelp: () => invoke('app:showHelp'),
    getInfo: () => invoke('app:getInfo'),
    checkUpdate: () => invoke('app:checkUpdate'),
    openProjectReadme: () => invoke('app:openProjectReadme'),
    exportConfig: () => invoke('app:exportConfig'),
    importConfig: () => invoke('app:importConfig'),
    healthCheck: () => invoke('app:healthCheck'),
    pickDirectory: () => invoke('app:pickDirectory'),
    runQuickCommand: (command: string, cwd?: string) => invoke('app:runQuickCommand', command, cwd)
  },
  events: {
    on: (listener: (e: MainEvent) => void): (() => void) => {
      const wrapped = (_evt: IpcRendererEvent, payload: MainEvent) => listener(payload)
      ipcRenderer.on('main-event', wrapped)
      return () => ipcRenderer.removeListener('main-event', wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type AppApi = typeof api
declare global {
  interface Window {
    api: AppApi
  }
}
