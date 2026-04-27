import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { Task, Run, NotificationItem, MainEvent } from '@shared/types'
import { api, unwrap } from './api'

type Tab = 'tasks' | 'runs' | 'notifications' | 'quick' | 'scripts' | 'settings'
type Lang = 'zh' | 'en'
type Theme = 'dark' | 'light'

interface StoreCtx {
  tab: Tab
  setTab: (t: Tab) => void

  tasks: Task[]
  refreshTasks: () => Promise<void>

  runs: Run[]
  refreshRuns: (taskId?: string) => Promise<void>

  notifications: NotificationItem[]
  refreshNotifications: () => Promise<void>
  unreadCount: number

  selectedTaskId: string | null
  selectTask: (id: string | null) => void

  selectedRunId: string | null
  selectRun: (id: string | null) => void

  editingTaskId: string | 'new' | null
  editTask: (id: string | 'new' | null) => void
  newTaskScriptPath: string | null
  setNewTaskScriptPath: (v: string | null) => void

  toast: string | null
  setToast: (t: string | null) => void

  lang: Lang
  setLang: (v: Lang) => void
  theme: Theme
  setTheme: (v: Theme) => void
  txt: (zh: string, en: string) => string
}

const Ctx = createContext<StoreCtx | null>(null)

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [tab, setTab] = useState<Tab>('tasks')
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<string | 'new' | null>(null)
  const [newTaskScriptPath, setNewTaskScriptPath] = useState<string | null>(null)
  const [toast, _setToast] = useState<string | null>(null)
  const [lang, setLang] = useState<Lang>(() => {
    const v = localStorage.getItem('taskball.lang')
    return v === 'en' ? 'en' : 'zh'
  })
  const [theme, setTheme] = useState<Theme>(() => {
    const v = localStorage.getItem('taskball.theme')
    return v === 'light' ? 'light' : 'dark'
  })
  const toastTimer = useRef<NodeJS.Timeout | null>(null)

  const txt = useCallback((zh: string, en: string) => (lang === 'en' ? en : zh), [lang])

  useEffect(() => {
    localStorage.setItem('taskball.lang', lang)
  }, [lang])

  useEffect(() => {
    localStorage.setItem('taskball.theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const setToast = useCallback((t: string | null) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    _setToast(t)
    if (t) {
      toastTimer.current = setTimeout(() => _setToast(null), 2800)
    }
  }, [])

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await unwrap(api.tasks.list()))
    } catch (e) {
      setToast((e as Error).message)
    }
  }, [setToast])

  const refreshRuns = useCallback(
    async (taskId?: string) => {
      try {
        setRuns(await unwrap(api.runs.list({ taskId, limit: 1000 })))
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    [setToast]
  )

  const refreshNotifications = useCallback(async () => {
    try {
      const [list, count] = await Promise.all([
        unwrap(api.notifications.listAll(200)),
        unwrap(api.notifications.unreadCount())
      ])
      setNotifications(list)
      setUnreadCount(count)
    } catch (e) {
      setToast((e as Error).message)
    }
  }, [setToast])

  // 初次加载
  useEffect(() => {
    refreshTasks()
    refreshRuns()
    refreshNotifications()
  }, [refreshTasks, refreshRuns, refreshNotifications])

  // 监听 main 事件
  useEffect(() => {
    const off = api.events.on((ev: MainEvent) => {
      if (
        ev.type === 'run:finished' ||
        ev.type === 'run:started' ||
        ev.type === 'run:auto-install'
      ) {
        refreshRuns(selectedTaskId ?? undefined)
      }
      if (ev.type === 'notification:new') {
        refreshNotifications()
      }
    })
    return off
  }, [refreshRuns, refreshNotifications, selectedTaskId])

  const value = useMemo<StoreCtx>(
    () => ({
      tab,
      setTab,
      tasks,
      refreshTasks,
      runs,
      refreshRuns,
      notifications,
      refreshNotifications,
      unreadCount,
      selectedTaskId,
      selectTask: setSelectedTaskId,
      selectedRunId,
      selectRun: setSelectedRunId,
      editingTaskId,
      editTask: setEditingTaskId,
      newTaskScriptPath,
      setNewTaskScriptPath,
      toast,
      setToast,
      lang,
      setLang,
      theme,
      setTheme,
      txt
    }),
    [
      tab,
      tasks,
      runs,
      notifications,
      unreadCount,
      selectedTaskId,
      selectedRunId,
      editingTaskId,
      newTaskScriptPath,
      toast,
      lang,
      theme,
      refreshTasks,
      refreshRuns,
      refreshNotifications,
      setToast,
      txt
    ]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): StoreCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('StoreProvider 缺失')
  return v
}
