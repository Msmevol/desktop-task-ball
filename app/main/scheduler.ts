import { RunsRepo, TasksRepo } from './db'
import { runTask } from './runner'
import { runtimeLog } from './logger'

let timer: NodeJS.Timeout | null = null
const runningTaskIds = new Set<string>()
const runningRetrySourceRunIds = new Set<string>()

function minsSince(iso?: string): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return (Date.now() - t) / 60_000
}

function buildArgsFromDefaults(taskId: string): Record<string, unknown> {
  const task = TasksRepo.get(taskId)
  if (!task) return {}
  const args: Record<string, unknown> = {}
  for (const [k, def] of Object.entries(task.argsSchema)) {
    if (def.default !== undefined) args[k] = def.default
  }
  return args
}

async function tick(): Promise<void> {
  const dueRetries = RunsRepo.listDueRetry(new Date().toISOString(), 50)
  for (const sourceRun of dueRetries) {
    if (RunsRepo.findRunningByTask(sourceRun.taskId)) {
      runtimeLog.info('scheduler_retry_skipped_task_running', {
        sourceRunId: sourceRun.runId,
        taskId: sourceRun.taskId
      })
      continue
    }
    if (runningRetrySourceRunIds.has(sourceRun.runId)) continue
    runningRetrySourceRunIds.add(sourceRun.runId)
    try {
      if (!RunsRepo.claimRetry(sourceRun.runId)) continue
      const nextRetryLeft = Math.max(0, (sourceRun.retryLeft ?? 0) - 1)
      runTask(sourceRun.taskId, sourceRun.inputArgs, {
        trigger: 'retry',
        retryLeft: nextRetryLeft,
        sourceRunId: sourceRun.runId
      })
    } catch {
      // ignore scheduler single-retry errors
    } finally {
      runningRetrySourceRunIds.delete(sourceRun.runId)
    }
  }

  const tasks = TasksRepo.list().filter((t) => t.scheduleEnabled && (t.scheduleEveryMin ?? 0) > 0)
  for (const task of tasks) {
    if (runningTaskIds.has(task.id)) continue
    const interval = Math.max(1, task.scheduleEveryMin ?? 60)
    const lastAt = task.lastScheduledAt
    if (minsSince(lastAt) < interval) continue
    runningTaskIds.add(task.id)
    try {
      TasksRepo.markScheduledNow(task.id)
      runTask(task.id, buildArgsFromDefaults(task.id), { trigger: 'schedule' })
    } catch {
      // ignore scheduler single-task errors
    } finally {
      runningTaskIds.delete(task.id)
    }
  }
}

export function startScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    tick().catch(() => undefined)
  }, 30_000)
  tick().catch(() => undefined)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
