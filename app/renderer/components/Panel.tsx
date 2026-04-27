import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { TaskList } from './TaskList'
import { TaskEditor } from './TaskEditor'
import { RunList } from './RunList'
import { RunDetail } from './RunDetail'
import { NotificationCenter } from './NotificationCenter'
import { SettingsView } from './Settings'
import { ScriptLibrary } from './ScriptLibrary'
import { api, unwrap } from '../api'

type QuickCommandItem = { name: string; command: string; cwd?: string }
type TabId = 'tasks' | 'runs' | 'notifications' | 'scripts' | 'settings' | 'quick'

export function Panel() {
  const {
    tab,
    setTab,
    unreadCount,
    editingTaskId,
    selectedRunId,
    toast,
    setToast,
    lang,
    setLang,
    theme,
    setTheme,
    txt
  } = useStore()
  const [isMaximized, setIsMaximized] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [quickCommands, setQuickCommands] = useState<QuickCommandItem[]>([])
  const [newQuickName, setNewQuickName] = useState('')
  const [newQuickCommand, setNewQuickCommand] = useState('')
  const [newQuickCwd, setNewQuickCwd] = useState('')

  const reloadQuickCommands = async () => {
    const r = await api.settings.get()
    if (r.ok) setQuickCommands(r.data.quickCommands ?? [])
  }

  const saveQuickCommands = async (next: QuickCommandItem[]) => {
    const settings = await unwrap(api.settings.get())
    await unwrap(api.settings.set({ ...settings, quickCommands: next }))
    setQuickCommands(next)
  }

  useEffect(() => {
    api.panel.isMaximized().then((r) => {
      if (r.ok) setIsMaximized(r.data)
    })
    api.settings.get().then((r) => {
      if (!r.ok) return
      if (!r.data.onboardingDone) setShowOnboarding(true)
      setQuickCommands(r.data.quickCommands ?? [])
    })
  }, [])

  const tabItems: Array<{
    id: TabId
    icon: string
    label: string
    description: string
    badge?: number
  }> = [
    {
      id: 'tasks',
      icon: '◎',
      label: txt('任务', 'Tasks'),
      description: txt('脚本与触发策略', 'Scripts and triggers')
    },
    {
      id: 'runs',
      icon: '↯',
      label: txt('运行记录', 'Runs'),
      description: txt('状态、日志与 AI 结果', 'Status, logs and AI')
    },
    {
      id: 'notifications',
      icon: '◌',
      label: txt('通知', 'Notifications'),
      description: txt('关键提醒与未读', 'Alerts and unread'),
      badge: unreadCount
    },
    {
      id: 'scripts',
      icon: '⬇',
      label: txt('脚本库', 'Script Library'),
      description: txt('上传与下载脚本', 'Upload and download scripts')
    },
    {
      id: 'settings',
      icon: '⚙',
      label: txt('设置', 'Settings'),
      description: txt('运行环境与高级项', 'Runtime and advanced')
    },
    {
      id: 'quick',
      icon: '⌘',
      label: txt('快捷命令', 'Quick Commands'),
      description: txt('通过小球右键菜单快速执行', 'Run quickly from the ball context menu')
    }
  ]

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-bg text-ink">
      <div className="drag h-16 flex items-center justify-between px-4 border-b border-line/80 bg-bg-elev/90 backdrop-blur-xl select-none">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-2xl bg-accent/20 border border-accent/30 grid place-items-center shadow-[0_12px_30px_rgba(96,165,250,0.18)]">
            <span className="text-accent text-lg font-black">●</span>
          </div>
          <div className="min-w-0">
            <div className="text-base font-bold tracking-wide truncate">{txt('任务球', 'Task Ball')}</div>
            <div className="text-xs text-ink-faint truncate">
              {txt('本地优先的个人自动化控制台', 'Local-first personal automation console')}
            </div>
          </div>
        </div>
        <div className="no-drag flex items-center gap-1.5">
          <button
            className="theme-chip"
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            title={txt('切换语言', 'Switch Language')}
          >
            {lang === 'zh' ? '中文' : 'EN'}
          </button>
          <button
            className="theme-chip"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={txt('切换主题', 'Switch Theme')}
          >
            {theme === 'dark' ? txt('深色', 'Dark') : txt('浅色', 'Light')}
          </button>
          <button
            className="btn-ghost btn h-8 px-2.5 text-xs"
            onClick={async () => {
              const r = await api.panel.toggleMaximize()
              if (r.ok) setIsMaximized(r.data)
            }}
            title={isMaximized ? txt('还原窗口', 'Restore') : txt('最大化窗口', 'Maximize')}
            aria-label={isMaximized ? txt('还原窗口', 'Restore') : txt('最大化窗口', 'Maximize')}
          >
            {isMaximized ? '❐' : '□'}
          </button>
          <button
            className="btn-danger btn h-8 px-2.5 text-xs"
            onClick={() => api.panel.hide()}
            title={txt('隐藏面板', 'Hide')}
            aria-label={txt('隐藏面板', 'Hide')}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-[280px] shrink-0 border-r border-line/80 bg-bg-elev/80 backdrop-blur-xl flex flex-col">
          <div className="p-4">
            <div className="panel-card p-3 bg-accent/10 border-accent/25">
              <div className="text-xs uppercase tracking-[0.2em] text-accent font-bold">Workspace</div>
              <div className="text-sm font-semibold mt-1">{txt('自动化驾驶舱', 'Automation cockpit')}</div>
              <div className="text-xs text-ink-faint mt-1">
                {txt('管理任务、复盘运行、配置 AI。', 'Manage tasks, review runs, configure AI.')}
              </div>
            </div>
          </div>
          <nav className="flex-1 px-3 pb-3 flex flex-col gap-1.5">
            {tabItems.map((item) => (
              <TabButton
                key={item.id}
                active={tab === item.id}
                onClick={() => setTab(item.id)}
                icon={item.icon}
                label={item.label}
                description={item.description}
                badge={item.badge}
              />
            ))}
          </nav>
          <div className="p-4 border-t border-line/80 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-wider text-ink-faint">v0.1.0</div>
              <button className="btn btn-ghost h-7 px-2 text-xs" onClick={() => api.app.showHelp()}>
                {txt('帮助', 'Help')}
              </button>
            </div>
            <div className="text-xs text-ink-faint">
              {txt('本地数据 · 隐私友好 · 可审计日志', 'Local data · Private · Auditable logs')}
            </div>
          </div>
        </aside>

        <main className="flex-1 overflow-hidden flex min-w-0 bg-bg/65">
          {tab === 'tasks' && (
            <div className="flex-1 flex overflow-hidden min-w-0">
              <div
                className={
                  editingTaskId
                    ? 'w-[430px] shrink-0 border-r border-line/80 overflow-y-auto'
                    : 'flex-1 overflow-y-auto'
                }
              >
                <TaskList />
              </div>
              {editingTaskId && (
                <div className="flex-1 min-w-[520px] overflow-y-auto bg-bg/40">
                  <TaskEditor />
                </div>
              )}
            </div>
          )}
          {tab === 'runs' && (
            <div className="flex-1 flex overflow-hidden min-w-0">
              <div
                className={
                  selectedRunId
                    ? 'w-[46%] min-w-[500px] max-w-[760px] shrink-0 border-r border-line/80 overflow-y-auto'
                    : 'flex-1 overflow-y-auto'
                }
              >
                <RunList />
              </div>
              {selectedRunId && (
                <div className="flex-1 min-w-[520px] overflow-y-auto bg-bg/40">
                  <RunDetail runId={selectedRunId} />
                </div>
              )}
            </div>
          )}
          {tab === 'notifications' && (
            <div className="flex-1 overflow-y-auto">
              <NotificationCenter />
            </div>
          )}
          {tab === 'settings' && (
            <div className="flex-1 overflow-y-auto">
              <SettingsView />
            </div>
          )}
          {tab === 'scripts' && (
            <div className="flex-1 overflow-y-auto">
              <ScriptLibrary />
            </div>
          )}
          {tab === 'quick' && (
            <QuickCommandsPane
              txt={txt}
              setToast={setToast}
              quickCommands={quickCommands}
              saveQuickCommands={saveQuickCommands}
              reloadQuickCommands={reloadQuickCommands}
              newQuickName={newQuickName}
              setNewQuickName={setNewQuickName}
              newQuickCommand={newQuickCommand}
              setNewQuickCommand={setNewQuickCommand}
              newQuickCwd={newQuickCwd}
              setNewQuickCwd={setNewQuickCwd}
            />
          )}
        </main>
      </div>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-2xl bg-bg-raised/95 border border-line-strong text-sm shadow-[var(--shadow-pop)] backdrop-blur-xl z-[80]">
          {toast}
        </div>
      )}

      {showOnboarding && (
        <div className="fixed inset-0 bg-black/65 backdrop-blur-sm flex items-center justify-center z-50 p-6">
          <div className="panel-card max-w-2xl w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="h-11 w-11 rounded-2xl bg-accent/15 border border-accent/30 grid place-items-center text-accent font-black">●</div>
              <div>
                <h3 className="text-xl font-bold">{txt('欢迎使用任务球', 'Welcome to Task Ball')}</h3>
                <div className="text-sm text-ink-dim mt-1">
                  {txt(
                    '建议先完成 3 个步骤：校验 Python 路径、检查 opencode 状态、创建并执行一个示例任务。',
                    'Start with three steps: verify Python path, check opencode status, then create and run a sample task.'
                  )}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              <div className="card p-3 bg-bg-raised/70"><div className="label mb-1">01</div>{txt('确认运行环境', 'Verify runtime')}</div>
              <div className="card p-3 bg-bg-raised/70"><div className="label mb-1">02</div>{txt('上传或选择脚本', 'Pick or upload a script')}</div>
              <div className="card p-3 bg-bg-raised/70"><div className="label mb-1">03</div>{txt('创建并运行任务', 'Create and run a task')}</div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                className="btn"
                onClick={async () => {
                  const r = await api.settings.get()
                  if (r.ok) await api.settings.set({ ...r.data, onboardingDone: true })
                  setShowOnboarding(false)
                }}
              >
                {txt('稍后处理', 'Later')}
              </button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const r = await api.settings.get()
                  if (r.ok) await api.settings.set({ ...r.data, onboardingDone: true })
                  setTab('settings')
                  setShowOnboarding(false)
                }}
              >
                {txt('去设置页', 'Go to Settings')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function QuickCommandsPane({
  txt,
  setToast,
  quickCommands,
  saveQuickCommands,
  reloadQuickCommands,
  newQuickName,
  setNewQuickName,
  newQuickCommand,
  setNewQuickCommand,
  newQuickCwd,
  setNewQuickCwd
}: {
  txt: (zh: string, en: string) => string
  setToast: (s: string | null) => void
  quickCommands: QuickCommandItem[]
  saveQuickCommands: (next: QuickCommandItem[]) => Promise<void>
  reloadQuickCommands: () => Promise<void>
  newQuickName: string
  setNewQuickName: (v: string) => void
  newQuickCommand: string
  setNewQuickCommand: (v: string) => void
  newQuickCwd: string
  setNewQuickCwd: (v: string) => void
}) {
  return (
    <div className="flex-1 overflow-y-auto page-shell">
      <div className="page-header">
        <div>
          <h2 className="text-lg font-bold">{txt('快捷命令', 'Quick Commands')}</h2>
          <div className="text-xs text-ink-faint mt-0.5">
            {txt('添加后可在悬浮小球右键菜单中直接执行。', 'Added commands appear in the floating ball context menu.')}
          </div>
        </div>
        <button
          className="btn"
          onClick={async () => {
            await reloadQuickCommands()
            setToast(txt('已同步快捷命令配置', 'Quick commands synchronized'))
          }}
        >
          {txt('刷新', 'Reload')}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-4">
        <div className="panel-card p-4 space-y-3">
          <div className="section-title">{txt('命令列表', 'Command List')}</div>
          {quickCommands.length === 0 ? (
            <div className="empty-state py-10">{txt('暂无快捷命令，请先新增。', 'No quick commands yet. Add one first.')}</div>
          ) : (
            <div className="space-y-2">
              {quickCommands.map((item, i) => (
                <div key={`${item.name}-${i}`} className="interactive-card p-3 flex gap-2 items-start">
                  <button
                    className="btn flex-1 justify-start text-left"
                    onClick={async () => {
                      try {
                        await unwrap(api.app.runQuickCommand(item.command, item.cwd))
                        setToast(txt(`命令已执行：${item.name}`, `Command executed: ${item.name}`))
                      } catch (e) {
                        setToast((e as Error).message)
                      }
                    }}
                    title={item.command}
                  >
                    <span className="text-accent">⌘</span>
                    <span className="min-w-0">
                      <span className="block truncate">{item.name}</span>
                      <span className="block text-xs text-ink-faint font-mono truncate">{item.command}</span>
                    </span>
                  </button>
                  <button
                    className="btn btn-danger h-9 px-3"
                    onClick={async () => {
                      const next = quickCommands.filter((_, idx) => idx !== i)
                      try {
                        await saveQuickCommands(next)
                        setToast(txt('快捷命令已删除', 'Quick command deleted'))
                      } catch (e) {
                        setToast((e as Error).message)
                      }
                    }}
                  >
                    {txt('删除', 'Delete')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel-card p-4 space-y-3">
          <div>
            <div className="section-title">{txt('新增快捷命令', 'Add Quick Command')}</div>
            <div className="text-xs text-ink-faint mt-1">
              {txt('适合保存常用构建、启动、部署或打开目录命令。', 'Good for build, start, deploy, or open-folder commands.')}
            </div>
          </div>
          <input
            className="input"
            value={newQuickName}
            onChange={(e) => setNewQuickName(e.target.value)}
            placeholder={txt('命令名称', 'Name')}
          />
          <input
            className="input font-mono"
            value={newQuickCommand}
            onChange={(e) => setNewQuickCommand(e.target.value)}
            placeholder={txt('命令内容，例如 npm run build', 'Command, e.g. npm run build')}
          />
          <div className="flex gap-2">
            <input
              className="input font-mono flex-1"
              value={newQuickCwd}
              onChange={(e) => setNewQuickCwd(e.target.value)}
              placeholder={txt('执行目录（留空=项目目录）', 'CWD (empty=project root)')}
            />
            <button
              className="btn"
              onClick={async () => {
                try {
                  const picked = await unwrap(api.app.pickDirectory())
                  if (picked) setNewQuickCwd(picked)
                } catch (e) {
                  setToast((e as Error).message)
                }
              }}
            >
              {txt('选择', 'Pick')}
            </button>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              className="btn btn-primary"
              onClick={async () => {
                const name = newQuickName.trim()
                const command = newQuickCommand.trim()
                const cwd = newQuickCwd.trim()
                if (!name || !command) {
                  setToast(txt('请填写命令名称与命令内容', 'Please provide command name and content'))
                  return
                }
                try {
                  const next = [...quickCommands, { name, command, cwd: cwd || undefined }]
                  await saveQuickCommands(next)
                  setNewQuickName('')
                  setNewQuickCommand('')
                  setNewQuickCwd('')
                  setToast(txt('快捷命令已添加', 'Quick command added'))
                } catch (e) {
                  setToast((e as Error).message)
                }
              }}
            >
              {txt('添加', 'Add')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  description,
  badge
}: {
  active: boolean
  onClick: () => void
  icon: string
  label: string
  description: string
  badge?: number
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={
        'group flex items-center gap-3 px-3 py-2.5 rounded-2xl text-left transition-all border ' +
        (active
          ? 'bg-accent/10 text-accent border-accent/35 shadow-[0_14px_32px_rgba(96,165,250,0.14)]'
          : 'text-ink-dim hover:text-ink hover:bg-bg-raised/70 border-transparent')
      }
    >
      <span
        className={
          'h-9 w-9 rounded-xl grid place-items-center shrink-0 border transition-colors ' +
          (active ? 'bg-accent/15 border-accent/30' : 'bg-bg-raised border-line group-hover:border-line-strong')
        }
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 font-semibold text-[15px]">
          <span className="truncate">{label}</span>
          {badge !== undefined && badge > 0 && (
            <span className="tag bg-danger/20 text-danger">{badge > 99 ? '99+' : badge}</span>
          )}
        </span>
        <span className="block text-xs text-ink-faint truncate mt-0.5">{description}</span>
      </span>
    </button>
  )
}
