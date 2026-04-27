import { useMemo, useState } from 'react'
import { api, unwrap } from '../api'
import { useStore } from '../store'
import type { Task, ArgDef } from '@shared/types'

export function TaskList() {
  const { tasks, editTask, setTab, selectTask, setToast, refreshTasks, refreshRuns, txt } = useStore()
  const [runTarget, setRunTarget] = useState<Task | null>(null)
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState('')

  const stats = useMemo(
    () => ({
      total: tasks.length,
      ai: tasks.filter((t) => t.aiEnabled !== false).length,
      scheduled: tasks.filter((t) => t.scheduleEnabled).length,
      muted: tasks.filter((t) => !t.notifyEnabled).length
    }),
    [tasks]
  )

  const availableTags = useMemo(
    () =>
      Array.from(
        new Set(
          tasks
            .map((t) => (t.tag ?? '').trim())
            .filter(Boolean)
        )
      ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    [tasks]
  )

  const filteredTasks = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return tasks.filter((t) => {
      const byTag = !tagFilter || (t.tag ?? '').trim() === tagFilter
      if (!byTag) return false
      if (!keyword) return true
      return `${t.name} ${t.tag ?? ''} ${t.description ?? ''} ${t.scriptPath}`
        .toLowerCase()
        .includes(keyword)
    })
  }, [tasks, query, tagFilter])

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h2 className="text-lg font-bold">{txt('任务', 'Tasks')}</h2>
          <div className="text-xs text-ink-faint mt-0.5">
            {txt('管理脚本、参数与触发策略', 'Manage scripts, args and triggers')}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => editTask('new')}>
          {txt('+ 新建任务', '+ New Task')}
        </button>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label={txt('总任务', 'Total')} value={stats.total} />
        <StatCard label={txt('AI 分析', 'AI Enabled')} value={stats.ai} />
        <StatCard label={txt('定时运行', 'Scheduled')} value={stats.scheduled} />
        <StatCard label={txt('静音任务', 'Muted')} value={stats.muted} />
      </div>

      <div className="panel-card p-3 flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
        <div>
          <div className="section-title">{txt('任务清单', 'Task Inventory')}</div>
          <div className="text-xs text-ink-faint mt-1">
            {txt('按标签、名称、描述或脚本路径快速过滤。', 'Filter by tag, name, description or script path.')}
          </div>
        </div>
        <div className="flex gap-2 w-full md:w-auto">
          <select
            className="input md:w-[180px]"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
          >
            <option value="">{txt('全部标签', 'All tags')}</option>
            {availableTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
          <input
            className="input md:max-w-[280px]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={txt('搜索任务...', 'Search tasks...')}
          />
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="empty-state py-14">
          <div className="text-base font-semibold mb-2">{txt('暂无任务。', 'No tasks yet.')}</div>
          <div className="text-xs max-w-md mx-auto">
            {txt(
              '请先创建任务，再在编辑器中上传本地脚本文件。',
              'Create a task first, then upload a local script in the editor.'
            )}
          </div>
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="empty-state py-10">
          {txt('未找到符合当前筛选条件的任务。', 'No tasks match the current filters.')}
        </div>
      ) : (
        <ul className="space-y-2">
          {filteredTasks.map((t) => (
            <li key={t.id} className="interactive-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-semibold truncate text-[15px]">{t.name}</span>
                    {t.tag && <span className="tag bg-line text-ink-faint">{t.tag}</span>}
                    {!t.notifyEnabled && <span className="tag bg-line text-ink-faint">{txt('静音', 'Muted')}</span>}
                    {t.scheduleEnabled && (
                      <span className="tag bg-accent/20 text-accent">
                        {txt(`每 ${t.scheduleEveryMin ?? 60} 分钟`, `Every ${t.scheduleEveryMin ?? 60} min`)}
                      </span>
                    )}
                  </div>
                  {t.description && <div className="text-xs text-ink-dim mb-1 truncate">{t.description}</div>}
                  <div className="text-xs text-ink-faint font-mono truncate">{t.scriptPath}</div>
                </div>
                <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                  <button className="btn btn-primary" onClick={() => setRunTarget(t)}>
                    {txt('运行', 'Run')}
                  </button>
                  <button className="btn" onClick={() => editTask(t.id)}>
                    {txt('编辑', 'Edit')}
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      selectTask(t.id)
                      setTab('runs')
                      refreshRuns(t.id)
                    }}
                  >
                    {txt('历史', 'History')}
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={async () => {
                      if (
                        !confirm(
                          txt(
                            `确认删除任务“${t.name}”？运行记录将保留。`,
                            `Confirm deleting task "${t.name}"? Run history will be retained.`
                          )
                        )
                      )
                        return
                      await unwrap(api.tasks.delete(t.id))
                      await refreshTasks()
                      setToast(txt('任务已删除', 'Task has been deleted'))
                    }}
                  >
                    {txt('删除', 'Delete')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {runTarget && <RunDialog task={runTarget} onClose={() => setRunTarget(null)} />}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="text-2xl font-black mt-1">{value}</div>
    </div>
  )
}

/**
 * 按 ArgDef 归一化默认值。TaskEditor 里参数默认值都是输入框里的原始字符串，
 * 运行时要按 schema 的 type 转成正确类型，不然提交到 main 时布尔参数会是字符串
 * "true"，再传给 CLI 会出问题。
 */
function normalizeDefault(def: ArgDef): unknown {
  const raw = def.default
  if (def.type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') return raw.toLowerCase() === 'true'
    return false
  }
  if (def.type === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  // string / enum
  return raw ?? ''
}

function RunDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { setToast, setTab, refreshRuns, selectRun, txt } = useStore()
  const entries = Object.entries(task.argsSchema)
  const initial: Record<string, unknown> = {}
  for (const [k, def] of entries) initial[k] = normalizeDefault(def)
  const [args, setArgs] = useState<Record<string, unknown>>(initial)
  const [busy, setBusy] = useState(false)

  const onRun = async () => {
    setBusy(true)
    try {
      // 主进程会立即返回 runId，任务执行在后台继续。
      const { runId } = await unwrap(api.tasks.run(task.id, args))
      setToast(txt(`运行已创建：${runId}`, `Run created: ${runId}`))
      selectRun(runId)
      setTab('runs')
      await refreshRuns()
      onClose()
    } catch (e) {
      setToast((e as Error).message)
      setBusy(false)
    }
    // 成功路径下 onClose() 会销毁组件，不需要 setBusy(false)
  }

  return (
    <div className="fixed inset-0 bg-black/65 backdrop-blur-sm flex items-center justify-center z-50 p-8">
      <div className="panel-card w-full max-w-md p-5">
        <h3 className="text-base font-semibold mb-1">
          {txt('运行：', 'Run: ')}
          {task.name}
        </h3>
        <div className="text-xs text-ink-faint font-mono mb-4">{task.scriptPath}</div>

        {entries.length === 0 ? (
          <div className="text-sm text-ink-dim mb-4">{txt('该任务未定义参数。', 'No parameters defined for this task.')}</div>
        ) : (
          <div className="space-y-3 mb-4">
            {entries.map(([name, def]) => (
              <ArgInput
                key={name}
                name={name}
                def={def}
                value={args[name]}
                onChange={(v) => setArgs((a) => ({ ...a, [name]: v }))}
              />
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose} disabled={busy}>
            {txt('取消', 'Cancel')}
          </button>
          <button className="btn btn-primary" onClick={onRun} disabled={busy}>
            {busy ? txt('请求提交中...', 'Submitting...') : txt('运行', 'Run')}
          </button>
        </div>
      </div>
    </div>
  )
}

function ArgInput({
  name,
  def,
  value,
  onChange
}: {
  name: string
  def: ArgDef
  value: unknown
  onChange: (v: unknown) => void
}) {
  const { txt } = useStore()
  return (
    <label className="block">
      <div className="label mb-1 flex items-center gap-2">
        <span>{name}</span>
        {def.required && <span className="text-danger">*</span>}
        <span className="text-ink-faint normal-case">({def.type})</span>
      </div>
      {def.type === 'enum' ? (
        <select className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">-</option>
          {def.enumValues?.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : def.type === 'boolean' ? (
        <label className="flex items-center gap-2 h-10 px-3 border border-line rounded-xl bg-bg-raised">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="accent-accent"
          />
          <span className="text-sm text-ink-dim">
            {txt(`勾选后传入 --${name}；未勾选时不传该参数。`, `Checked: pass --${name}; unchecked: omit this argument.`)}
          </span>
        </label>
      ) : (
        <input
          className="input"
          type={def.type === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          placeholder={def.description}
          onChange={(e) => {
            if (def.type === 'number') {
              onChange(e.target.value === '' ? '' : Number(e.target.value))
              return
            }
            onChange(e.target.value)
          }}
        />
      )}
      {def.description && <div className="text-xs text-ink-faint mt-1">{def.description}</div>}
    </label>
  )
}
