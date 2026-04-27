import { useEffect, useMemo, useState } from 'react'
import { api, unwrap } from '../api'
import { useStore } from '../store'
import type { Run, RunStage } from '@shared/types'

function formatTime(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function stageTag(stage: RunStage, txt: (zh: string, en: string) => string) {
  switch (stage) {
    case 'running':
      return <span className="tag bg-accent/20 text-accent">{txt('运行中', 'Running')}</span>
    case 'done':
      return <span className="tag bg-success/20 text-success">{txt('完成', 'Done')}</span>
    case 'failed':
      return <span className="tag bg-danger/20 text-danger">{txt('失败', 'Failed')}</span>
  }
}

const FAIL_REASON_LABEL: Record<string, string> = {
  script_error: '脚本错误',
  timeout: '超时',
  bad_output: '输出异常',
  ai_error: 'AI 错误',
  python_missing: 'Python 不可用',
  cancelled: '已取消'
}
const FAIL_REASON_LABEL_EN: Record<string, string> = {
  script_error: 'Script Error',
  timeout: 'Timeout',
  bad_output: 'Bad Output',
  ai_error: 'AI Error',
  python_missing: 'Python Missing',
  cancelled: 'Cancelled'
}

export function RunList() {
  const {
    runs,
    selectedTaskId,
    selectedRunId,
    selectRun,
    tasks,
    refreshRuns,
    selectTask,
    setToast,
    refreshNotifications,
    txt,
    lang
  } = useStore()
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [deleting, setDeleting] = useState(false)
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null)
  const PAGE_SIZE = 20

  useEffect(() => {
    refreshRuns(selectedTaskId ?? undefined).catch(console.error)
  }, [selectedTaskId, refreshRuns])

  useEffect(() => {
    setPage(1)
    setSelectionMode(false)
    setSelectedIds([])
  }, [selectedTaskId])

  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t.name])), [tasks])
  const filteredRuns = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return runs.filter((r) => {
      const scriptStage = r.scriptStage ?? r.stage
      if (onlyFailed && scriptStage !== 'failed') return false
      if (!kw) return true
      const text = `${taskMap.get(r.taskId) ?? r.taskId} ${r.runId} ${r.failReason ?? ''} ${r.stderrExcerpt ?? ''}`.toLowerCase()
      return text.includes(kw)
    })
  }, [runs, onlyFailed, q, taskMap])

  const stats = useMemo(() => {
    const total = filteredRuns.length
    const failed = filteredRuns.filter((r) => (r.scriptStage ?? r.stage) === 'failed').length
    const done = filteredRuns.filter((r) => (r.scriptStage ?? r.stage) === 'done').length
    const completedWithDuration = filteredRuns.filter(
      (r) => (r.scriptStage ?? r.stage) === 'done' && typeof r.durationMs === 'number'
    )
    const avgMs = completedWithDuration.length > 0
      ? Math.round(completedWithDuration.reduce((a, b) => a + (b.durationMs ?? 0), 0) / completedWithDuration.length)
      : 0
    const successRate = total > 0 ? Math.round((done / total) * 100) : 0
    return { total, failed, done, avgMs, successRate }
  }, [filteredRuns])

  const totalPages = Math.max(1, Math.ceil(filteredRuns.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)

  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])

  const pageRuns = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE
    return filteredRuns.slice(start, start + PAGE_SIZE)
  }, [filteredRuns, safePage])

  const pageRunIds = pageRuns.map((r) => r.runId)
  const selectedSet = new Set(selectedIds)
  const allCheckedOnPage =
    pageRunIds.length > 0 && pageRunIds.every((id) => selectedSet.has(id))
  const selectedCount = selectedIds.length
  const pageTokens = buildPageTokens(totalPages, safePage)

  const toggleOne = (runId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      if (checked) return Array.from(new Set([...prev, runId]))
      return prev.filter((id) => id !== runId)
    })
  }

  const togglePageAll = (checked: boolean) => {
    setSelectedIds((prev) => {
      if (checked) return Array.from(new Set([...prev, ...pageRunIds]))
      const pageSet = new Set(pageRunIds)
      return prev.filter((id) => !pageSet.has(id))
    })
  }

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelectedIds([])
  }

  const enterSelectionMode = () => {
    setSelectionMode(true)
    setSelectedIds([])
  }

  const deleteSelected = async () => {
    if (selectedIds.length === 0) return
    if (!confirm(txt(`确认删除已选中的 ${selectedIds.length} 条运行记录？`, `Confirm deletion of ${selectedIds.length} selected run records?`))) return
    setDeleting(true)
    try {
      const { deleted } = await unwrap(api.runs.deleteMany(selectedIds))
      if (selectedRunId && selectedIds.includes(selectedRunId)) selectRun(null)
      exitSelectionMode()
      await Promise.all([
        refreshRuns(selectedTaskId ?? undefined),
        refreshNotifications()
      ])
      setToast(txt(`已删除 ${deleted} 条运行记录`, `${deleted} run records deleted`))
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const deleteAllFailed = async () => {
    const tip = selectedTaskId ? txt('当前任务下的全部失败记录', 'all failed records for current task') : txt('全部失败记录', 'all failed records')
    if (!confirm(txt(`确认删除${tip}？`, `Confirm deletion of ${tip}?`))) return
    const selectedBeforeDelete = selectedRunId ? runs.find((r) => r.runId === selectedRunId) : undefined
    const shouldClearSelected =
      !!selectedBeforeDelete &&
      (selectedBeforeDelete.scriptStage ?? selectedBeforeDelete.stage) === 'failed' &&
      (!selectedTaskId || selectedBeforeDelete.taskId === selectedTaskId)
    setDeleting(true)
    try {
      const { deleted } = await unwrap(api.runs.deleteFailed(selectedTaskId ?? undefined))
      if (shouldClearSelected) selectRun(null)
      exitSelectionMode()
      await Promise.all([
        refreshRuns(selectedTaskId ?? undefined),
        refreshNotifications()
      ])
      setToast(txt(`已删除 ${deleted} 条失败记录`, `${deleted} failed records deleted`))
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const cancelRun = async (runId: string) => {
    setCancellingRunId(runId)
    try {
      const result = await unwrap(api.runs.cancel(runId))
      setToast(result.message)
      await refreshRuns(selectedTaskId ?? undefined)
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setCancellingRunId(null)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h2 className="text-lg font-bold">{txt('运行记录', 'Runs')}</h2>
          <div className="text-xs text-ink-faint mt-0.5">
            {txt('实时查看执行状态，并支持批量清理失败记录。', 'View run status in real time and batch-clean failed records.')}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <select
            className="input w-52"
            value={selectedTaskId ?? ''}
            onChange={(e) => selectTask(e.target.value || null)}
          >
            <option value="">{txt('全部任务', 'All tasks')}</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {!selectionMode ? (
            <button className="btn btn-secondary" onClick={enterSelectionMode}>
              {txt('批量管理', 'Batch Manage')}
            </button>
          ) : (
            <>
              <button
                className="btn btn-danger"
                onClick={deleteSelected}
                disabled={selectedCount === 0 || deleting}
              >
                {deleting ? txt('处理中...', 'Processing...') : txt(`删除已选 (${selectedCount})`, `Delete Selected (${selectedCount})`)}
              </button>
              <button className="btn" onClick={exitSelectionMode} disabled={deleting}>
                {txt('取消', 'Cancel')}
              </button>
            </>
          )}
          <button className="btn btn-danger" onClick={deleteAllFailed} disabled={deleting}>
            {txt('清理失败记录', 'Clear Failed Records')}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
        <div className="metric">
          <div className="text-xs text-ink-faint uppercase tracking-wider">{txt('总数', 'Total')}</div>
          <div className="text-lg font-semibold">{stats.total}</div>
        </div>
        <div className="metric">
          <div className="text-xs text-ink-faint uppercase tracking-wider">{txt('成功率', 'Success Rate')}</div>
          <div className="text-lg font-semibold text-accent">{stats.successRate}%</div>
        </div>
        <div className="metric">
          <div className="text-xs text-ink-faint uppercase tracking-wider">{txt('失败', 'Failed')}</div>
          <div className="text-lg font-semibold text-danger">{stats.failed}</div>
        </div>
        <div className="metric">
          <div className="text-xs text-ink-faint uppercase tracking-wider">{txt('平均耗时', 'Avg Duration')}</div>
          <div className="text-lg font-semibold">
          {stats.avgMs > 0 ? `${(stats.avgMs / 1000).toFixed(1)}s` : '-'}
          </div>
        </div>
      </div>
      <div className="panel-card p-3 flex items-center gap-2">
        <input
          className="input flex-1"
          placeholder={txt('搜索运行 ID / 任务名称 / 错误信息', 'Search run ID / task name / error')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(1)
          }}
        />
        <label className="flex items-center gap-2 text-sm text-ink-dim">
          <input
            type="checkbox"
            checked={onlyFailed}
            onChange={(e) => {
              setOnlyFailed(e.target.checked)
              setPage(1)
            }}
          />
          {txt('仅显示失败记录', 'Failed Only')}
        </label>
      </div>
      <div className="flex items-center justify-between text-sm text-ink-dim">
        {selectionMode ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allCheckedOnPage}
              onChange={(e) => togglePageAll(e.target.checked)}
            />
            <span>{txt('本页全选', 'Select page')}</span>
          </label>
        ) : (
          <span />
        )}
        <span>
          {txt(`第 ${safePage}/${totalPages} 页，共 ${runs.length} 条记录`, `Page ${safePage}/${totalPages}, ${runs.length} records`)}
        </span>
      </div>

      {filteredRuns.length === 0 ? (
        <div className="panel-card p-8 text-center text-ink-dim">{txt('暂无运行记录。', 'No run records yet.')}</div>
      ) : (
        <ul className="space-y-1">
          {pageRuns.map((r) => (
            <RunRow
              key={r.runId}
              run={r}
              taskName={taskMap.get(r.taskId) ?? r.taskId}
              active={selectedRunId === r.runId}
              onClick={() => selectRun(r.runId)}
              showCheckbox={selectionMode}
              checked={selectedSet.has(r.runId)}
              onCheck={toggleOne}
              onCancel={cancelRun}
              cancelBusy={cancellingRunId === r.runId}
              txt={txt}
              lang={lang}
            />
          ))}
        </ul>
      )}
      {filteredRuns.length > 0 && (
        <div className="mt-3 flex items-center justify-end gap-1.5">
          <button className="btn" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
            {txt('上一页', 'Prev')}
          </button>
          {pageTokens.map((token, i) =>
            token === '...' ? (
              <span key={`ellipsis-${i}`} className="px-2 text-ink-faint">
                ...
              </span>
            ) : (
              <button
                key={token}
                className={'btn ' + (token === safePage ? 'btn-primary' : '')}
                onClick={() => setPage(token)}
              >
                {token}
              </button>
            )
          )}
          <button
            className="btn"
            disabled={safePage >= totalPages}
            onClick={() => setPage(safePage + 1)}
          >
            {txt('下一页', 'Next')}
          </button>
        </div>
      )}
    </div>
  )
}

function RunRow({
  run,
  taskName,
  active,
  onClick,
  showCheckbox,
  checked,
  onCheck,
  onCancel,
  cancelBusy,
  txt,
  lang
}: {
  run: Run
  taskName: string
  active: boolean
  onClick: () => void
  showCheckbox: boolean
  checked: boolean
  onCheck: (runId: string, checked: boolean) => void
  onCancel: (runId: string) => void
  cancelBusy: boolean
  txt: (zh: string, en: string) => string
  lang: 'zh' | 'en'
}) {
  return (
    <li>
      <div
        className={
          'p-3.5 rounded-2xl transition-all border ' +
          (active
            ? 'bg-accent/10 border-accent/45 shadow-[0_6px_14px_rgba(74,168,255,0.12)]'
            : 'bg-bg-elev/45 border-transparent hover:bg-bg-elev hover:border-line hover:shadow-[var(--shadow-soft)]')
        }
      >
        <div className="flex items-start gap-2">
          {showCheckbox && (
            <input
              type="checkbox"
              className="mt-1"
              checked={checked}
              onChange={(e) => onCheck(run.runId, e.target.checked)}
            />
          )}
          <div onClick={onClick} className="flex-1 text-left cursor-pointer">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[15px] font-medium truncate">{taskName}</span>
              <div className="flex items-center gap-1.5">
                {(run.scriptStage ?? run.stage) === 'running' && (
                  <button
                    className="btn btn-danger h-7 px-2 text-xs"
                    disabled={cancelBusy}
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      onCancel(run.runId)
                    }}
                  >
                    {cancelBusy ? txt('取消中...', 'Cancelling...') : txt('取消', 'Cancel')}
                  </button>
                )}
                {stageTag(run.scriptStage ?? run.stage, txt)}
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm text-ink-faint">
              <span className="font-mono">{formatTime(run.startedAt)}</span>
              {run.durationMs !== undefined && <span>{(run.durationMs / 1000).toFixed(1)}s</span>}
              {run.failReason && (run.scriptStage ?? run.stage) === 'failed' && (
                <span className="text-danger">
                  {(lang === 'en' ? FAIL_REASON_LABEL_EN : FAIL_REASON_LABEL)[run.failReason] ??
                    run.failReason}
                </span>
              )}
              {run.notified && <span className="text-warn">🔔</span>}
            </div>
          </div>
        </div>
      </div>
    </li>
  )
}

function buildPageTokens(total: number, current: number): Array<number | '...'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  if (current <= 4) return [1, 2, 3, 4, 5, '...', total]
  if (current >= total - 3) return [1, '...', total - 4, total - 3, total - 2, total - 1, total]
  return [1, '...', current - 1, current, current + 1, '...', total]
}
