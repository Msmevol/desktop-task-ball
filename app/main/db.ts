import initSqlJs, { Database as SqlJsDatabase, BindParams } from 'sql.js'
import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { paths } from './paths'
import type {
  Task,
  TaskInput,
  TaskPatch,
  Run,
  RunStage,
  AiStage,
  FailReason,
  NotificationItem,
  Settings,
  AiResult,
  AiProvider,
  RunCommand,
  RunTrigger
} from '@shared/types'

/**
 * sql.js 是 SQLite 的纯 WASM 构建。特点：
 *   - 初始化是异步的
 *   - 全程内存运行，靠我们自己序列化到磁盘（防抖 300ms）
 *
 * 对外暴露一层薄的 prepare/get/run/all 封装，让 repo 代码保持熟悉的写法。
 */

let sqljsDb: SqlJsDatabase | null = null
let saveTimer: NodeJS.Timeout | null = null
let dbFilePath = ''

function loadWasmBinary(): Buffer {
  // 手动从 node_modules 里读 WASM 二进制，避免依赖 import.meta / require 的歧义
  const candidates = [
    path.join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'),
    path.join(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm'),
    path.join(__dirname, '../../../node_modules/sql.js/dist/sql-wasm.wasm')
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p)
  }
  throw new Error('未找到 sql.js WASM 二进制，请确认依赖已正确安装（npm install）')
}

export async function initDb(): Promise<void> {
  dbFilePath = paths().dbPath
  const wasmBuf = loadWasmBinary()
  const wasmBinary = wasmBuf.buffer.slice(
    wasmBuf.byteOffset,
    wasmBuf.byteOffset + wasmBuf.byteLength
  ) as ArrayBuffer
  const SQL = await initSqlJs({ wasmBinary })

  if (fs.existsSync(dbFilePath)) {
    const bytes = fs.readFileSync(dbFilePath)
    sqljsDb = new SQL.Database(bytes)
  } else {
    sqljsDb = new SQL.Database()
  }

  sqljsDb.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      tag                  TEXT,
      description          TEXT,
      script_path          TEXT NOT NULL,
      args_schema_json     TEXT NOT NULL,
      timeout_sec          INTEGER NOT NULL DEFAULT 600,
      schedule_enabled     INTEGER NOT NULL DEFAULT 0,
      schedule_every_min   INTEGER,
      retry_count          INTEGER NOT NULL DEFAULT 0,
      retry_delay_sec      INTEGER NOT NULL DEFAULT 15,
      notify_on_failure    INTEGER NOT NULL DEFAULT 1,
      notify_on_timeout    INTEGER NOT NULL DEFAULT 1,
      last_scheduled_at    TEXT,
      ai_enabled           INTEGER NOT NULL DEFAULT 1,
      ai_provider          TEXT NOT NULL DEFAULT 'opencode',
      failure_ai_enabled   INTEGER NOT NULL DEFAULT 1,
      failure_ai_prompt    TEXT NOT NULL DEFAULT '',
      system_prompt        TEXT NOT NULL,
      user_prompt_template TEXT NOT NULL,
      notify_enabled       INTEGER NOT NULL DEFAULT 1,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id               TEXT PRIMARY KEY,
      task_id              TEXT NOT NULL,
      input_args_json      TEXT NOT NULL,
      stage                TEXT NOT NULL,
      script_stage         TEXT,
      ai_stage             TEXT,
      fail_reason          TEXT,
      exit_code            INTEGER,
      started_at           TEXT NOT NULL,
      ended_at             TEXT,
      duration_ms          INTEGER,
      stdout_excerpt       TEXT,
      stderr_excerpt       TEXT,
      raw_log_path         TEXT,
      script_output_json   TEXT,
      rendered_prompt      TEXT,
      ai_result_json       TEXT,
      ai_raw_response      TEXT,
      ai_error             TEXT,
      notified             INTEGER NOT NULL DEFAULT 0,
      command_json         TEXT,
      auto_install_attempts_json TEXT,
      trigger              TEXT,
      retry_left           INTEGER,
      source_run_id        TEXT,
      next_retry_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      run_id     TEXT NOT NULL,
      task_id    TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      read       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read, created_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // ---------- 迁移 ----------

  // runs 表兼容：command_json 列
  try {
    sqljsDb.exec('ALTER TABLE runs ADD COLUMN command_json TEXT')
  } catch {
    /* 列已存在 */
  }
  try {
    sqljsDb.exec('ALTER TABLE runs ADD COLUMN auto_install_attempts_json TEXT')
  } catch {
    /* 列已存在 */
  }
  for (const sql of [
    'ALTER TABLE runs ADD COLUMN trigger TEXT',
    'ALTER TABLE runs ADD COLUMN retry_left INTEGER',
    'ALTER TABLE runs ADD COLUMN source_run_id TEXT',
    'ALTER TABLE runs ADD COLUMN next_retry_at TEXT',
    'ALTER TABLE runs ADD COLUMN script_stage TEXT',
    'ALTER TABLE runs ADD COLUMN ai_stage TEXT',
    'ALTER TABLE runs ADD COLUMN ai_raw_response TEXT'
  ]) {
    try {
      sqljsDb.exec(sql)
    } catch {
      /* 列已存在 */
    }
  }

  // settings 表迁移：删除旧的 opencodeUrl / opencodeModel
  // 它们在 v0.2 后不再使用；保留会让 UI 产生幻觉一样的配置项
  try {
    sqljsDb.exec("DELETE FROM settings WHERE key IN ('opencodeUrl', 'opencodeModel')")
  } catch {
    /* ignore */
  }
  // tasks 表兼容：调度/重试/通知规则
  for (const sql of [
    'ALTER TABLE tasks ADD COLUMN tag TEXT',
    'ALTER TABLE tasks ADD COLUMN schedule_enabled INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN schedule_every_min INTEGER',
    'ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN retry_delay_sec INTEGER NOT NULL DEFAULT 15',
    'ALTER TABLE tasks ADD COLUMN notify_on_failure INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE tasks ADD COLUMN notify_on_timeout INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE tasks ADD COLUMN last_scheduled_at TEXT',
    'ALTER TABLE tasks ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 1',
    "ALTER TABLE tasks ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'opencode'",
    "ALTER TABLE tasks ADD COLUMN failure_ai_enabled INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE tasks ADD COLUMN failure_ai_prompt TEXT NOT NULL DEFAULT ''"
  ]) {
    try {
      sqljsDb.exec(sql)
    } catch {
      /* 列已存在 */
    }
  }

  scheduleSave()
}

function db(): SqlJsDatabase {
  if (!sqljsDb) throw new Error('数据库尚未初始化')
  return sqljsDb
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => saveNow(), 300)
}

let isSaving = false
let pendingSave = false

export function saveNow(): void {
  if (!sqljsDb) return
  if (isSaving) {
    pendingSave = true
    return
  }
  isSaving = true
  try {
    const data = sqljsDb.export()
    const tmp = dbFilePath + '.tmp'
    fs.promises.writeFile(tmp, Buffer.from(data))
      .then(() => fs.promises.rename(tmp, dbFilePath))
      .catch(err => console.error('DB async save failed:', err))
      .finally(() => {
        isSaving = false
        if (pendingSave) {
          pendingSave = false
          scheduleSave()
        }
      })
  } catch (err) {
    console.error('DB export failed:', err)
    isSaving = false
  }
}

export function closeDb(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (sqljsDb) {
    try {
      const data = sqljsDb.export()
      const tmp = dbFilePath + '.tmp'
      fs.writeFileSync(tmp, Buffer.from(data))
      fs.renameSync(tmp, dbFilePath)
    } catch (e) {
      console.error('Sync save in closeDb failed:', e)
    }
  }
  sqljsDb?.close()
  sqljsDb = null
}

function normalize(params: unknown[]): BindParams {
  return params.map((p) => (p === undefined ? null : p)) as BindParams
}

function runSql(sql: string, params: unknown[] = []): void {
  const stmt = db().prepare(sql)
  try {
    stmt.bind(normalize(params))
    stmt.step()
  } finally {
    stmt.free()
  }
  scheduleSave()
}

function getOne(sql: string, params: unknown[] = []): Record<string, unknown> | null {
  const stmt = db().prepare(sql)
  try {
    stmt.bind(normalize(params))
    if (stmt.step()) return stmt.getAsObject()
    return null
  } finally {
    stmt.free()
  }
}

function getAll(sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const stmt = db().prepare(sql)
  const out: Array<Record<string, unknown>> = []
  try {
    stmt.bind(normalize(params))
    while (stmt.step()) out.push(stmt.getAsObject())
  } finally {
    stmt.free()
  }
  return out
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

const DEFAULT_SETTINGS: Settings = {
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  opencodeBinPath: '',
  opencodePort: 4097,
  openaiBaseUrl: '',
  openaiApiKey: '',
  openaiModel: 'gpt-4o-mini',
  openaiTimeoutSec: 60,
  openaiHeaders: [],
  autoInstallEnabled: true,
  quickCommands: [],
  scriptServerEnabled: false,
  scriptServerBaseUrl: '',
  onboardingDone: false
}

// ---------- Tasks ----------

function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as string,
    name: r.name as string,
    tag: (r.tag as string | null) ?? undefined,
    description: (r.description as string | null) ?? undefined,
    scriptPath: r.script_path as string,
    argsSchema: JSON.parse(r.args_schema_json as string),
    timeoutSec: r.timeout_sec as number,
    scheduleEnabled: !!r.schedule_enabled,
    scheduleEveryMin: (r.schedule_every_min as number | null) ?? undefined,
    retryCount: (r.retry_count as number | null) ?? 0,
    retryDelaySec: (r.retry_delay_sec as number | null) ?? 15,
    notifyOnFailure: r.notify_on_failure === null ? true : !!r.notify_on_failure,
    notifyOnTimeout: r.notify_on_timeout === null ? true : !!r.notify_on_timeout,
    lastScheduledAt: (r.last_scheduled_at as string | null) ?? undefined,
    aiEnabled: r.ai_enabled === null ? true : !!r.ai_enabled,
    aiProvider: ((r.ai_provider as string | null) ?? 'opencode') as AiProvider,
    failureAiEnabled: r.failure_ai_enabled === null ? true : !!r.failure_ai_enabled,
    failureAiPrompt: (r.failure_ai_prompt as string | null) ?? '',
    systemPrompt: r.system_prompt as string,
    userPromptTemplate: r.user_prompt_template as string,
    notifyEnabled: !!r.notify_enabled,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  }
}

export const TasksRepo = {
  list(): Task[] {
    return getAll('SELECT * FROM tasks ORDER BY updated_at DESC').map(rowToTask)
  },
  get(id: string): Task | null {
    const r = getOne('SELECT * FROM tasks WHERE id = ?', [id])
    return r ? rowToTask(r) : null
  },
  create(input: TaskInput): Task {
    const now = new Date().toISOString()
    const id = 't_' + nanoid(10)
    runSql(
      `INSERT INTO tasks
       (id, name, tag, description, script_path, args_schema_json, timeout_sec,
        schedule_enabled, schedule_every_min, retry_count, retry_delay_sec, notify_on_failure, notify_on_timeout,
       ai_enabled, ai_provider, failure_ai_enabled, failure_ai_prompt, system_prompt, user_prompt_template, notify_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.tag?.trim() || null,
        input.description ?? null,
        input.scriptPath,
        JSON.stringify(input.argsSchema ?? {}),
        input.timeoutSec ?? 600,
        input.scheduleEnabled ? 1 : 0,
        input.scheduleEnabled ? (input.scheduleEveryMin ?? 60) : null,
        input.retryCount ?? 0,
        input.retryDelaySec ?? 15,
        input.notifyOnFailure === false ? 0 : 1,
        input.notifyOnTimeout === false ? 0 : 1,
        input.aiEnabled === false ? 0 : 1,
        input.aiProvider ?? 'opencode',
        input.failureAiEnabled === false ? 0 : 1,
        input.failureAiPrompt ?? '',
        input.systemPrompt,
        input.userPromptTemplate,
        input.notifyEnabled ? 1 : 0,
        now,
        now
      ]
    )
    return this.get(id)!
  },
  update(id: string, patch: TaskPatch): Task | null {
    const cur = this.get(id)
    if (!cur) return null
    const next: Task = { ...cur, ...patch, id, updatedAt: new Date().toISOString() }
    runSql(
      `UPDATE tasks
       SET name=?, tag=?, description=?, script_path=?, args_schema_json=?, timeout_sec=?,
           schedule_enabled=?, schedule_every_min=?, retry_count=?, retry_delay_sec=?, notify_on_failure=?, notify_on_timeout=?,
           ai_enabled=?, ai_provider=?, failure_ai_enabled=?, failure_ai_prompt=?, system_prompt=?, user_prompt_template=?, notify_enabled=?, updated_at=?
       WHERE id=?`,
      [
        next.name,
        next.tag?.trim() || null,
        next.description ?? null,
        next.scriptPath,
        JSON.stringify(next.argsSchema ?? {}),
        next.timeoutSec,
        next.scheduleEnabled ? 1 : 0,
        next.scheduleEnabled ? (next.scheduleEveryMin ?? 60) : null,
        next.retryCount ?? 0,
        next.retryDelaySec ?? 15,
        next.notifyOnFailure === false ? 0 : 1,
        next.notifyOnTimeout === false ? 0 : 1,
        next.aiEnabled === false ? 0 : 1,
        next.aiProvider ?? 'opencode',
        next.failureAiEnabled === false ? 0 : 1,
        next.failureAiPrompt ?? '',
        next.systemPrompt,
        next.userPromptTemplate,
        next.notifyEnabled ? 1 : 0,
        next.updatedAt,
        id
      ]
    )
    return this.get(id)
  },
  delete(id: string): void {
    runSql('DELETE FROM tasks WHERE id = ?', [id])
  }
  ,
  markScheduledNow(id: string): void {
    runSql('UPDATE tasks SET last_scheduled_at = ?, updated_at = ? WHERE id = ?', [
      new Date().toISOString(),
      new Date().toISOString(),
      id
    ])
  }
}

// ---------- Runs ----------

function rowToRun(r: Record<string, unknown>): Run {
  return {
    runId: r.run_id as string,
    taskId: r.task_id as string,
    inputArgs: JSON.parse(r.input_args_json as string),
    scriptStage: (r.script_stage as RunStage | null) ?? undefined,
    aiStage: (r.ai_stage as AiStage | null) ?? undefined,
    stage: r.stage as RunStage,
    failReason: (r.fail_reason as FailReason | null) ?? undefined,
    exitCode: (r.exit_code as number | null) ?? undefined,
    startedAt: r.started_at as string,
    endedAt: (r.ended_at as string | null) ?? undefined,
    durationMs: (r.duration_ms as number | null) ?? undefined,
    stdoutExcerpt: (r.stdout_excerpt as string | null) ?? undefined,
    stderrExcerpt: (r.stderr_excerpt as string | null) ?? undefined,
    rawLogPath: (r.raw_log_path as string | null) ?? undefined,
    scriptOutputJson: r.script_output_json
      ? JSON.parse(r.script_output_json as string)
      : undefined,
    renderedPrompt: (r.rendered_prompt as string | null) ?? undefined,
    aiResultJson: r.ai_result_json
      ? (JSON.parse(r.ai_result_json as string) as AiResult)
      : undefined,
    aiRawResponse: (r.ai_raw_response as string | null) ?? undefined,
    aiError: (r.ai_error as string | null) ?? undefined,
    notified: !!r.notified,
    command: r.command_json ? JSON.parse(r.command_json as string) : undefined,
    autoInstallAttempts: r.auto_install_attempts_json
      ? JSON.parse(r.auto_install_attempts_json as string)
      : undefined,
    trigger: (r.trigger as RunTrigger | null) ?? undefined,
    retryLeft: (r.retry_left as number | null) ?? undefined,
    sourceRunId: (r.source_run_id as string | null) ?? undefined,
    nextRetryAt: (r.next_retry_at as string | null) ?? undefined
  }
}

export const RunsRepo = {
  create(run: {
    runId: string
    taskId: string
    inputArgs: Record<string, unknown>
    startedAt: string
    command?: RunCommand
    trigger?: RunTrigger
    retryLeft?: number
    sourceRunId?: string
  }): void {
    runSql(
      `INSERT INTO runs (
        run_id, task_id, input_args_json, stage, script_stage, ai_stage, started_at, notified, command_json,
        trigger, retry_left, source_run_id
      )
       VALUES (?, ?, ?, 'running', 'running', 'pending', ?, 0, ?, ?, ?, ?)`,
      [
        run.runId,
        run.taskId,
        JSON.stringify(run.inputArgs),
        run.startedAt,
        run.command ? JSON.stringify(run.command) : null,
        run.trigger ?? 'manual',
        run.retryLeft ?? 0,
        run.sourceRunId ?? null
      ]
    )
  },
  finish(runId: string, patch: Partial<Run>): Run | null {
    const cur = this.get(runId)
    if (!cur) return null
    const next: Run = { ...cur, ...patch }
    runSql(
      `UPDATE runs SET
         stage=?, script_stage=?, ai_stage=?, fail_reason=?, exit_code=?, ended_at=?, duration_ms=?,
         stdout_excerpt=?, stderr_excerpt=?, raw_log_path=?, script_output_json=?,
         rendered_prompt=?, ai_result_json=?, ai_raw_response=?, ai_error=?, notified=?, auto_install_attempts_json=?,
         trigger=?, retry_left=?, source_run_id=?, next_retry_at=?
       WHERE run_id=?`,
      [
        next.stage,
        next.scriptStage ?? next.stage,
        next.aiStage ?? null,
        next.failReason ?? null,
        next.exitCode ?? null,
        next.endedAt ?? null,
        next.durationMs ?? null,
        next.stdoutExcerpt ?? null,
        next.stderrExcerpt ?? null,
        next.rawLogPath ?? null,
        next.scriptOutputJson === undefined ? null : JSON.stringify(next.scriptOutputJson),
        next.renderedPrompt ?? null,
        next.aiResultJson ? JSON.stringify(next.aiResultJson) : null,
        next.aiRawResponse ?? null,
        next.aiError ?? null,
        next.notified ? 1 : 0,
        next.autoInstallAttempts ? JSON.stringify(next.autoInstallAttempts) : null,
        next.trigger ?? null,
        next.retryLeft ?? null,
        next.sourceRunId ?? null,
        next.nextRetryAt ?? null,
        runId
      ]
    )
    return this.get(runId)
  },
  get(runId: string): Run | null {
    const r = getOne('SELECT * FROM runs WHERE run_id = ?', [runId])
    return r ? rowToRun(r) : null
  },
  findRunningByTask(taskId: string): Run | null {
    const r = getOne("SELECT * FROM runs WHERE task_id = ? AND stage = 'running' ORDER BY started_at DESC LIMIT 1", [
      taskId
    ])
    return r ? rowToRun(r) : null
  },
  list(filter: { taskId?: string; limit?: number } = {}): Run[] {
    const limit = filter.limit ?? 100
    const rows = filter.taskId
      ? getAll('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?', [
          filter.taskId,
          limit
        ])
      : getAll('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?', [limit])
    return rows.map(rowToRun)
  },
  latestForTask(taskId: string): Run | null {
    const r = getOne(
      'SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1',
      [taskId]
    )
    return r ? rowToRun(r) : null
  },
  deleteMany(runIds: string[]): number {
    const uniq = Array.from(new Set(runIds.filter(Boolean)))
    if (uniq.length === 0) return 0
    const marks = placeholders(uniq.length)
    const existingRows = getAll(`SELECT run_id FROM runs WHERE run_id IN (${marks})`, uniq)
    const existingRunIds = existingRows.map((x) => String(x.run_id))
    if (existingRunIds.length === 0) return 0
    const existingMarks = placeholders(existingRunIds.length)
    runSql(`DELETE FROM notifications WHERE run_id IN (${existingMarks})`, existingRunIds)
    runSql(`DELETE FROM runs WHERE run_id IN (${existingMarks})`, existingRunIds)
    return existingRunIds.length
  },
  deleteFailed(taskId?: string): number {
    const ids = taskId
      ? getAll("SELECT run_id FROM runs WHERE COALESCE(script_stage, stage)='failed' AND task_id = ?", [taskId])
      : getAll("SELECT run_id FROM runs WHERE COALESCE(script_stage, stage)='failed'")
    const runIds = ids.map((x) => String(x.run_id))
    return this.deleteMany(runIds)
  },
  listDueRetry(nowIso: string, limit = 20): Run[] {
    const rows = getAll(
      `SELECT * FROM runs
       WHERE COALESCE(script_stage, stage)='failed'
         AND next_retry_at IS NOT NULL
         AND next_retry_at <= ?
       ORDER BY next_retry_at ASC
       LIMIT ?`,
      [nowIso, limit]
    )
    return rows.map(rowToRun)
  },
  claimRetry(runId: string): boolean {
    const before = getOne('SELECT next_retry_at FROM runs WHERE run_id = ?', [runId])
    if (!before || !before.next_retry_at) return false
    runSql('UPDATE runs SET next_retry_at = NULL WHERE run_id = ?', [runId])
    return true
  }
}

// ---------- Notifications ----------

function rowToNotif(r: Record<string, unknown>): NotificationItem {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    taskId: r.task_id as string,
    title: r.title as string,
    body: r.body as string,
    read: !!r.read,
    createdAt: r.created_at as string
  }
}

export const NotificationsRepo = {
  create(input: {
    runId: string
    taskId: string
    title: string
    body: string
  }): NotificationItem {
    const id = 'n_' + nanoid(10)
    const createdAt = new Date().toISOString()
    runSql(
      `INSERT INTO notifications (id, run_id, task_id, title, body, read, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [id, input.runId, input.taskId, input.title, input.body, createdAt]
    )
    return {
      id,
      runId: input.runId,
      taskId: input.taskId,
      title: input.title,
      body: input.body,
      read: false,
      createdAt
    }
  },
  listAll(limit = 100): NotificationItem[] {
    return getAll(
      'SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?',
      [limit]
    ).map(rowToNotif)
  },
  unreadCount(): number {
    const r = getOne('SELECT COUNT(*) AS c FROM notifications WHERE read = 0')
    return (r?.c as number) ?? 0
  },
  markRead(id: string): void {
    runSql('UPDATE notifications SET read = 1 WHERE id = ?', [id])
  },
  markAllRead(): void {
    runSql('UPDATE notifications SET read = 1 WHERE read = 0')
  }
}

// ---------- Settings ----------

export const SettingsRepo = {
  get(): Settings {
    const rows = getAll('SELECT key, value FROM settings') as Array<{
      key: string
      value: string
    }>
    const map = new Map(rows.map((r) => [r.key, r.value]))
    const parsedPort = Number(map.get('opencodePort'))
    const opencodePort =
      Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
        ? Math.floor(parsedPort)
        : DEFAULT_SETTINGS.opencodePort
    const parsedOpenaiTimeoutSec = Number(map.get('openaiTimeoutSec'))
    const openaiTimeoutSec =
      Number.isFinite(parsedOpenaiTimeoutSec) && parsedOpenaiTimeoutSec > 0
        ? Math.floor(parsedOpenaiTimeoutSec)
        : DEFAULT_SETTINGS.openaiTimeoutSec
    let quickCommands: Array<{ name: string; command: string; cwd?: string }> = []
    let openaiHeaders: Array<{ key: string; value: string; enabled?: boolean }> = []
    try {
      const raw = map.get('quickCommandsJson')
      if (raw) {
        const arr = JSON.parse(raw) as Array<{ name?: unknown; command?: unknown; cwd?: unknown }>
        if (Array.isArray(arr)) {
          quickCommands = arr
            .map((x) => ({
              name: String(x?.name ?? '').trim(),
              command: String(x?.command ?? '').trim(),
              cwd: typeof x?.cwd === 'string' && x.cwd.trim() ? x.cwd.trim() : undefined
            }))
            .filter((x) => x.name && x.command)
        }
      }
    } catch {
      /* ignore invalid JSON */
    }
    // 兼容老配置（单条命令）
    if (quickCommands.length === 0) {
      const legacyName = (map.get('quickCommandName') ?? '').trim()
      const legacyCmd = (map.get('quickCommand') ?? '').trim()
      if (legacyCmd) {
        quickCommands = [{ name: legacyName || '一键命令', command: legacyCmd }]
      }
    }
    try {
      const raw = map.get('openaiHeadersJson')
      if (raw) {
        const arr = JSON.parse(raw) as Array<{ key?: unknown; value?: unknown; enabled?: unknown }>
        if (Array.isArray(arr)) {
          const used = new Set<string>()
          openaiHeaders = arr
            .map((x) => ({
              key: String(x?.key ?? '').trim(),
              value: String(x?.value ?? ''),
              enabled: x?.enabled === false ? false : true
            }))
            .filter((x) => {
              if (!x.key) return false
              const lower = x.key.toLowerCase()
              if (used.has(lower)) return false
              used.add(lower)
              return true
            })
        }
      }
    } catch {
      /* ignore invalid JSON */
    }

    return {
      pythonPath: map.get('pythonPath') ?? DEFAULT_SETTINGS.pythonPath,
      opencodeBinPath: map.get('opencodeBinPath') ?? DEFAULT_SETTINGS.opencodeBinPath,
      opencodePort,
      openaiBaseUrl: map.get('openaiBaseUrl') ?? DEFAULT_SETTINGS.openaiBaseUrl,
      openaiApiKey: map.get('openaiApiKey') ?? DEFAULT_SETTINGS.openaiApiKey,
      openaiModel: map.get('openaiModel') ?? DEFAULT_SETTINGS.openaiModel,
      openaiTimeoutSec,
      openaiHeaders,
      autoInstallEnabled:
        map.get('autoInstallEnabled') === undefined
          ? DEFAULT_SETTINGS.autoInstallEnabled
          : map.get('autoInstallEnabled') === 'true',
      quickCommands,
      scriptServerEnabled:
        map.get('scriptServerEnabled') === undefined
          ? DEFAULT_SETTINGS.scriptServerEnabled
          : map.get('scriptServerEnabled') === 'true',
      scriptServerBaseUrl: map.get('scriptServerBaseUrl') ?? DEFAULT_SETTINGS.scriptServerBaseUrl,
      onboardingDone:
        map.get('onboardingDone') === undefined
          ? DEFAULT_SETTINGS.onboardingDone
          : map.get('onboardingDone') === 'true'
    }
  },
  set(patch: Partial<Settings>): Settings {
    // 白名单：只接受已知字段，防止脏数据
    const allowedKeys: Array<keyof Settings> = [
      'pythonPath',
      'opencodeBinPath',
      'opencodePort',
      'openaiBaseUrl',
      'openaiApiKey',
      'openaiModel',
      'openaiTimeoutSec',
      'openaiHeaders',
      'autoInstallEnabled',
      'quickCommands',
      'scriptServerEnabled',
      'scriptServerBaseUrl',
      'onboardingDone'
    ]
    for (const k of allowedKeys) {
      const v = patch[k]
      if (v !== undefined) {
        if (k === 'opencodePort') {
          const n = Number(v)
          if (!Number.isFinite(n) || n <= 0 || n > 65535) continue
          runSql(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [k, String(Math.floor(n))]
          )
          continue
        }
        if (k === 'openaiTimeoutSec') {
          const n = Number(v)
          if (!Number.isFinite(n) || n <= 0 || n > 600) continue
          runSql(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [k, String(Math.floor(n))]
          )
          continue
        }
        if (k === 'quickCommands') {
          const arr = Array.isArray(v) ? v : []
          const normalized = arr
            .map((x) => ({
              name: String((x as { name?: unknown })?.name ?? '').trim(),
              command: String((x as { command?: unknown })?.command ?? '').trim(),
              cwd:
                typeof (x as { cwd?: unknown })?.cwd === 'string' &&
                String((x as { cwd?: unknown }).cwd).trim()
                  ? String((x as { cwd?: unknown }).cwd).trim()
                  : undefined
            }))
            .filter((x) => x.name && x.command)
          runSql(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            ['quickCommandsJson', JSON.stringify(normalized)]
          )
          continue
        }
        if (k === 'openaiHeaders') {
          const arr = Array.isArray(v) ? v : []
          const used = new Set<string>()
          const normalized = arr
            .map((x) => ({
              key: String((x as { key?: unknown })?.key ?? '').trim(),
              value: String((x as { value?: unknown })?.value ?? ''),
              enabled: (x as { enabled?: unknown })?.enabled === false ? false : true
            }))
            .filter((x) => {
              if (!x.key) return false
              const lower = x.key.toLowerCase()
              if (used.has(lower)) return false
              used.add(lower)
              return true
            })
          runSql(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            ['openaiHeadersJson', JSON.stringify(normalized)]
          )
          continue
        }
        runSql(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          [k, String(v)]
        )
      }
    }
    return this.get()
  }
}
