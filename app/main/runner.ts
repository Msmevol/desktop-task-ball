import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { dialog } from 'electron'
import treeKill from 'tree-kill'
import { paths } from './paths'
import { TasksRepo, RunsRepo, NotificationsRepo, SettingsRepo } from './db'
import { renderTemplate } from './prompt'
import { analyzeFailureReason, analyzeMissingModule, callAi } from './ai'
import { showNotification } from './notify'
import { broadcast } from './events'
import { opencode } from './opencode'
import {
  buildBatchInstallCmd,
  checkPython,
  detectMissingModulesForScript,
  isInstallArgvSafe,
  moduleToPackageName,
  parseModuleNotFound
} from './python'
import type {
  Task,
  Run,
  RunCommand,
  ArgDef,
  Settings,
  AutoInstallAttempt,
  PythonInfo,
  RunTrigger
} from '@shared/types'
import { runtimeLog } from './logger'

const STDOUT_MAX = 8 * 1024
const STDERR_MAX = 4 * 1024
const CANCEL_MESSAGE = '运行已由用户取消'

type RunMeta = {
  retryLeft?: number
  trigger?: RunTrigger
  sourceRunId?: string
}

type ScriptKind = 'python' | 'batch' | 'powershell'

export function detectScriptKind(scriptPath: string): ScriptKind | null {
  const ext = path.extname(scriptPath).toLowerCase()
  if (ext === '.py') return 'python'
  if (ext === '.bat' || ext === '.cmd') return 'batch'
  if (ext === '.ps1') return 'powershell'
  return null
}

function validateArgs(task: Task, args: Record<string, unknown>): void {
  for (const [name, def] of Object.entries(task.argsSchema)) {
    const val = args[name]
    if (val === undefined || val === null || val === '') {
      if (def.required) throw new Error(`缺少必填参数: ${name}`)
      continue
    }
    if (def.type === 'number' && typeof val !== 'number' && isNaN(Number(val))) {
      throw new Error(`参数 "${name}" 必须为数字`)
    }
    if (def.type === 'enum' && def.enumValues && !def.enumValues.includes(String(val))) {
      throw new Error(`参数 "${name}" 必须为以下值之一: ${def.enumValues.join(', ')}`)
    }
  }
}

function resolveScript(scriptPath: string): string {
  const tasksDir = paths().tasksDir
  const kind = detectScriptKind(scriptPath)
  if (!kind) {
    throw new Error(`仅支持 .py / .bat / .cmd / .ps1 脚本: ${scriptPath}`)
  }
  const abs = path.resolve(tasksDir, scriptPath)
  const root = path.resolve(tasksDir)
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error(`脚本必须位于 tasks/ 目录下: ${scriptPath}`)
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`脚本不存在: ${abs}`)
  }
  return abs
}

function quoteCmdArg(v: string): string {
  if (!/[\s"&|<>^()%!]/.test(v)) return v
  return `"${v.replace(/"/g, '""')}"`
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s
  return '...（截断，仅保留末尾 ' + max + ' 字节）...\n' + s.slice(s.length - max)
}

function tryParseJson(s: string): { parsed: unknown; ok: boolean } {
  const trimmed = s.trim()
  if (!trimmed) return { parsed: null, ok: false }
  try {
    return { parsed: JSON.parse(trimmed), ok: true }
  } catch {
    return { parsed: null, ok: false }
  }
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function askInstallConfirmation(input: {
  taskName: string
  runId: string
  missing: string
  argv: string[]
}): boolean {
  const detail =
    `运行 ID: ${input.runId}\n` +
    `缺失依赖: ${input.missing}\n\n` +
    `拟执行命令:\n${input.argv.join(' ')}\n\n` +
    '是否批准本次依赖安装？'
  const picked = dialog.showMessageBoxSync({
    type: 'warning',
    title: '依赖安装审批',
    message: `任务“${input.taskName}”检测到缺失依赖`,
    detail,
    buttons: ['批准并执行', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  return picked === 0
}

/** 把单个参数值序列化成 CLI 字符串（python argparse 接收形式） */
function serializeArgValue(v: unknown): string {
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  // 对象/数组：紧凑 JSON 作为单个参数值
  return JSON.stringify(v)
}

/**
 * 把 args 对象展开成 ["--name", "value", ...]。
 *  - boolean: 按 argparse store_true 语义 —— true 只输出 "--xxx"，false 什么都不输出
 *  - 字符串 "true"/"false" 也按 boolean 处理（UI 可能存成字符串）
 *  - 其他类型：--name value
 *  - 空串/null/undefined 跳过
 *  - 参数名不合法的跳过
 */
export function argsToCliFlags(
  args: Record<string, unknown>,
  schema: Record<string, ArgDef>
): string[] {
  const out: string[] = []
  for (const [key, val] of Object.entries(args)) {
    if (val === undefined || val === null || val === '') continue
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) continue

    const def = schema[key]
    const isBool =
      def?.type === 'boolean' ||
      typeof val === 'boolean' ||
      val === 'true' ||
      val === 'false'

    if (isBool) {
      const truthy = val === true || val === 'true'
      if (truthy) out.push('--' + key)
      // false 什么都不 push
      continue
    }

    out.push('--' + key, serializeArgValue(val))
  }
  return out
}

interface SpawnResult {
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  stdout: string
  stderr: string
}

type ActiveRunProc = {
  runId: string
  taskId: string
  child: ChildProcessWithoutNullStreams
  cancelRequested: boolean
}

const activeRunProcesses = new Map<string, ActiveRunProc>()

async function spawnAndWait(
  command: RunCommand,
  runCtx?: { runId: string; taskId: string }
): Promise<SpawnResult> {
  let stdout = ''
  let stderr = ''
  let exitCode: number | null = null
  let timedOut = false
  let cancelled = false

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.pythonPath, command.argv.slice(1), {
      cwd: command.cwd,
      env: { ...process.env, ...command.env }
    })
    if (runCtx) {
      activeRunProcesses.set(runCtx.runId, {
        runId: runCtx.runId,
        taskId: runCtx.taskId,
        child,
        cancelRequested: false
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) {
          treeKill(child.pid, 'SIGKILL', (err) => {
            if (err) runtimeLog.warn('tree_kill_err', { pid: child.pid, error: String(err) })
          })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        /* ignore */
      }
    }, command.timeoutSec * 1000)

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      if (runCtx) {
        const active = activeRunProcesses.get(runCtx.runId)
        if (active?.child === child) activeRunProcesses.delete(runCtx.runId)
      }
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      exitCode = code
      if (runCtx) {
        const active = activeRunProcesses.get(runCtx.runId)
        cancelled = !!active?.cancelRequested
        if (active?.child === child) activeRunProcesses.delete(runCtx.runId)
      }
      resolve()
    })
  })

  return { exitCode, timedOut, cancelled, stdout, stderr }
}

/**
 * 分段 append 日志，带统一时间戳前缀。过程中任何崩溃，已写的段都保留。
 */
class RunLogger {
  private readonly logPath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(logPath: string) {
    this.logPath = logPath
    fs.writeFileSync(this.logPath, '')
  }

  private append(text: string) {
    this.queue = this.queue
      .then(() => fs.promises.appendFile(this.logPath, text))
      .catch(e => runtimeLog.error('log_write_err', { error: String(e) }))
  }

  section(title: string): void {
    const ts = new Date().toISOString()
    this.append(`\n[${ts}] === ${title} ===\n`)
  }
  kv(key: string, value: unknown): void {
    const line = `${key.padEnd(16)}${fmt(value)}\n`
    this.append(line)
  }
  raw(text: string): void {
    this.append(text)
    if (!text.endsWith('\n')) this.append('\n')
  }
}

/**
 * 启动一次任务。只同步做准备工作（校验、写 input.json、建 run 记录），
 * 拿到 runId 后立即返回；真正的执行（spawn → AI → 通知）放到后台。
 *
 * UI 通过 run:started / run:finished 事件实时刷新进度，不再阻塞在"运行"弹窗。
 */
export function runTask(
  taskId: string,
  args: Record<string, unknown>,
  meta: RunMeta = {}
): { runId: string } {
  const task = TasksRepo.get(taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)
  const trigger = meta.trigger ?? 'manual'
  const running = RunsRepo.findRunningByTask(taskId)
  if (running) {
    runtimeLog.info('run_skip_task_already_running', {
      taskId,
      taskName: task.name,
      trigger,
      activeRunId: running.runId
    })
    if (trigger === 'manual') {
      throw new Error(`任务正在运行中，请稍后重试。运行 ID: ${running.runId}`)
    }
    throw new Error(`任务正在运行，本次触发已跳过。运行 ID: ${running.runId}`)
  }

  validateArgs(task, args)
  const scriptAbs = resolveScript(task.scriptPath)

  const runId = 'r_' + nanoid(12)
  const startedAt = new Date().toISOString()
  const startMs = Date.now()

  const runDir = path.join(paths().runsDir, runId)
  fs.mkdirSync(runDir, { recursive: true })
  const inputFile = path.join(runDir, 'input.json')
  const rawLog = path.join(runDir, 'raw.log')

  // 参数快照。脚本不需要读它，仅用于 UI 展示和复现。
  fs.writeFileSync(inputFile, JSON.stringify({ runId, args }, null, 2))

  const settings = SettingsRepo.get()
  const retryLeft = Math.max(0, meta.retryLeft ?? task.retryCount ?? 0)
  runtimeLog.info('run_start', {
    runId,
    taskId,
    taskName: task.name,
    trigger,
    retryLeft,
    sourceRunId: meta.sourceRunId
  })
  const env: Record<string, string> = {
    TASK_BALL_RUN_ID: runId,
    TASK_BALL_INPUT_JSON: inputFile
  }
  const cwd = paths().tasksDir
  const cliFlags = argsToCliFlags(args, task.argsSchema)
  const scriptKind = detectScriptKind(scriptAbs)
  if (!scriptKind) {
    throw new Error(`不支持的脚本类型: ${task.scriptPath}`)
  }

  let command: RunCommand
  if (scriptKind === 'python') {
    env.PYTHONIOENCODING = 'utf-8'
    command = {
      pythonPath: settings.pythonPath,
      scriptPath: scriptAbs,
      argv: [settings.pythonPath, scriptAbs, ...cliFlags],
      cwd,
      timeoutSec: task.timeoutSec,
      inputFile,
      env
    }
  } else if (scriptKind === 'powershell') {
    command = {
      pythonPath: 'powershell.exe',
      scriptPath: scriptAbs,
      argv: [
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptAbs,
        ...cliFlags
      ],
      cwd,
      timeoutSec: task.timeoutSec,
      inputFile,
      env
    }
  } else {
    // cmd /c 接受一段命令字符串，避免 .bat 关联执行差异
    const line = [quoteCmdArg(scriptAbs), ...cliFlags.map((x) => quoteCmdArg(x))].join(' ')
    command = {
      pythonPath: 'cmd.exe',
      scriptPath: scriptAbs,
      argv: ['cmd.exe', '/d', '/s', '/c', line],
      cwd,
      timeoutSec: task.timeoutSec,
      inputFile,
      env
    }
  }

  RunsRepo.create({
    runId,
    taskId,
    inputArgs: args,
    startedAt,
    command,
    trigger,
    retryLeft,
    sourceRunId: meta.sourceRunId
  })
  broadcast({ type: 'run:started', runId, taskId })

  // Fire-and-forget：executeRun 内部兜住所有预期错误并写库；
  // catch 是再多一层兜底，防止有未预期的同步抛出
  executeRun({ task, runId, startMs, command, rawLog, args, settings, retryLeft }).catch(
    (e) => {
      console.error('executeRun 捕获到未处理异常:', e)
      runtimeLog.error('run_uncaught_execute_error', {
        runId,
        taskId,
        error: (e as Error).message ?? String(e)
      })
      try {
        RunsRepo.finish(runId, {
          stage: 'failed',
          scriptStage: 'failed',
          aiStage: 'skipped',
          failReason: 'script_error',
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          stderrExcerpt: (e as Error).message ?? String(e),
          rawLogPath: rawLog
        })
        broadcast({ type: 'run:finished', runId, taskId })
      } catch {
        /* ignore */
      }
    }
  )

  return { runId }
}

export function cancelRun(runId: string): { cancelled: boolean; message: string } {
  const run = RunsRepo.get(runId)
  if (!run) throw new Error(`运行记录不存在: ${runId}`)
  if (run.stage !== 'running') {
    return { cancelled: false, message: '该运行已结束，无需取消。' }
  }
  const active = activeRunProcesses.get(runId)
  if (!active) {
    return { cancelled: false, message: '当前阶段不可取消（可能正在执行 AI 分析）。' }
  }
  active.cancelRequested = true
  try {
    if (active.child.pid) {
      treeKill(active.child.pid, 'SIGKILL', (err) => {
        if (err) runtimeLog.warn('tree_kill_err', { pid: active.child.pid, error: String(err) })
      })
    } else {
      active.child.kill('SIGKILL')
    }
  } catch {
    // ignore kill race
  }
  runtimeLog.info('run_cancel_requested', { runId, taskId: run.taskId })
  return { cancelled: true, message: '取消请求已提交，请稍候刷新状态。' }
}

/** 后台执行主体：spawn → 解析输出 → 调 AI → 通知。所有错误路径都写库。 */
async function executeRun(ctx: {
  task: Task
  runId: string
  startMs: number
  command: RunCommand
  rawLog: string
  args: Record<string, unknown>
  settings: Settings
  retryLeft: number
}): Promise<void> {
  const { task, runId, startMs, command, rawLog, args, settings, retryLeft } = ctx
  const taskId = task.id
  const scriptKind = detectScriptKind(command.scriptPath)
  const isPythonScript = scriptKind === 'python'

  const log = new RunLogger(rawLog)
  log.section('Run Metadata')
  log.kv('Run ID:', runId)
  log.kv('Task ID:', taskId)
  log.kv('Task Name:', task.name)
  log.kv('Trigger:', RunsRepo.get(runId)?.trigger ?? 'manual')
  log.kv('Retry Left:', retryLeft)
  log.kv('Started At:', new Date(startMs).toISOString())
  log.kv('Script Path:', task.scriptPath + '  (-> ' + command.scriptPath + ')')

  log.section('Command')
  log.kv('Executor:', command.pythonPath)
  log.kv('Script:', command.scriptPath)
  log.kv('CWD:', command.cwd)
  log.kv('Timeout:', command.timeoutSec + ' s')
  log.kv('Input File:', command.inputFile)
  log.kv('Argv:', command.argv)
  log.kv('Env (+):', command.env)
  log.kv(
    'Shell-ish:',
    command.argv.map((p) => (/[\s"]/.test(p) ? JSON.stringify(p) : p)).join(' ')
  )

  log.section('Input Args Snapshot')
  log.raw(JSON.stringify(args, null, 2))

  const autoInstallAttempts: AutoInstallAttempt[] = []
  const finalizeCancelled = (stderrTip?: string) => {
    const duration = Date.now() - startMs
    log.section('Finished')
    log.kv('Stage:', 'failed (cancelled)')
    log.kv('Total Duration:', duration + ' ms')
    RunsRepo.finish(runId, {
      stage: 'failed',
      scriptStage: 'failed',
      aiStage: 'skipped',
      failReason: 'cancelled',
      endedAt: new Date().toISOString(),
      durationMs: duration,
      stderrExcerpt: stderrTip ?? CANCEL_MESSAGE,
      rawLogPath: rawLog,
      autoInstallAttempts,
      nextRetryAt: undefined
    })
    runtimeLog.info('run_cancelled', { runId, taskId, durationMs: duration })
    broadcast({ type: 'run:finished', runId, taskId })
  }
  let pythonInfo: PythonInfo | null = null
  log.section('Python Check')
  if (!isPythonScript) {
    log.kv('Status:', `skipped (${scriptKind ?? 'unknown'} script)`)
  } else {
    try {
      pythonInfo = await checkPython(settings.pythonPath)
    } catch (e) {
      pythonInfo = {
        ok: false,
        pythonPath: settings.pythonPath,
        envKind: 'unknown',
        errorType: 'probe_crash',
        error: (e as Error).message,
        detectedAt: new Date().toISOString()
      }
    }
    if (!pythonInfo.ok) {
      log.kv('Status:', 'failed')
      log.kv('Error Type:', pythonInfo.errorType ?? 'unknown')
      log.raw(pythonInfo.error ?? 'python check failed')
      const duration = Date.now() - startMs
      RunsRepo.finish(runId, {
        stage: 'failed',
        scriptStage: 'failed',
        aiStage: 'skipped',
        failReason: 'python_missing',
        endedAt: new Date().toISOString(),
        durationMs: duration,
        stderrExcerpt: pythonInfo.error ?? 'Python 不可用',
        rawLogPath: rawLog
      })
      runtimeLog.warn('run_failed_python_missing', {
        runId,
        taskId,
        errorType: pythonInfo.errorType ?? 'unknown',
        error: pythonInfo.error ?? 'python check failed'
      })
      broadcast({ type: 'run:finished', runId, taskId })
      return
    }
    log.kv('Status:', 'ok')
    log.kv('Version:', pythonInfo.version ?? '(unknown)')
    log.kv('Env Kind:', pythonInfo.envKind)
    log.kv('pip Available:', String(!!pythonInfo.pipAvailable))
  }
  const autoInstallEnabled = isPythonScript && settings.autoInstallEnabled !== false
  const canInstallByEnv =
    isPythonScript && !!pythonInfo && (pythonInfo.envKind === 'uv' || !!pythonInfo.pipAvailable)
  let preflightInstallAttempted = false

  if (autoInstallEnabled && canInstallByEnv) {
    const py = pythonInfo as PythonInfo
    const missingModules = await detectMissingModulesForScript(
      py.pythonPath,
      command.scriptPath
    )
    const missingPkgs = Array.from(new Set(missingModules.map(moduleToPackageName)))
    if (missingPkgs.length > 0) {
      preflightInstallAttempted = true
      log.section('Preflight Dependency Check')
      log.kv('Missing Modules:', missingModules)
      log.kv('Install Packages:', missingPkgs)

      const remindTitle = `任务“${task.name}”检测到缺失依赖`
      const remindBody = `待安装依赖: ${missingPkgs.join(', ')}`
      showNotification(remindTitle, remindBody)
      const notif = NotificationsRepo.create({
        runId,
        taskId,
        title: remindTitle,
        body: remindBody
      })
      broadcast({ type: 'notification:new', id: notif.id })

      const installArgv = buildBatchInstallCmd(py, missingPkgs)
      const allowedExec = [
        py.pythonPath,
        py.executable ?? '',
        command.pythonPath,
        'uv',
        'uv.exe'
      ].filter(Boolean)
      const attempt: AutoInstallAttempt = {
        missingModule: missingModules.join(', '),
        retried: false,
        success: false,
        at: new Date().toISOString(),
        suggestion: {
          package_name: missingPkgs.join(', '),
          install_argv: installArgv,
          reasoning: '运行前依赖扫描发现缺包，按当前环境一次性安装',
          safe: true
        }
      }
      if (!isInstallArgvSafe(installArgv, allowedExec)) {
        attempt.error = '预安装命令未通过本地白名单校验'
      } else {
        const approved = askInstallConfirmation({
          taskName: task.name,
          runId,
          missing: missingPkgs.join(', '),
          argv: installArgv
        })
        if (!approved) {
          attempt.error = '用户拒绝依赖安装'
          autoInstallAttempts.push(attempt)
          RunsRepo.finish(runId, { autoInstallAttempts })
          broadcast({ type: 'run:auto-install', runId, attempt })
          runtimeLog.info('run_preflight_auto_install_rejected', { runId, taskId, packages: missingPkgs })
          const title = `已取消依赖安装: ${task.name}`
          const body = `用户拒绝安装依赖: ${missingPkgs.join(', ')}`
          showNotification(title, body)
          const notif = NotificationsRepo.create({ runId, taskId, title, body })
          broadcast({ type: 'notification:new', id: notif.id })
          finalizeCancelled('用户拒绝依赖安装')
          return
        }
        const installCommand: RunCommand = {
          pythonPath: installArgv[0],
          scriptPath: '<preflight-install>',
          argv: installArgv,
          cwd: command.cwd,
          timeoutSec: 300,
          inputFile: command.inputFile,
          env: command.env
        }
        const install = await spawnAndWait(installCommand, { runId, taskId })
        attempt.installExitCode = install.exitCode ?? undefined
        attempt.installStdoutTail = tail(install.stdout, 2000)
        attempt.installStderrTail = tail(install.stderr, 2000)
        if (install.cancelled) {
          attempt.error = CANCEL_MESSAGE
          autoInstallAttempts.push(attempt)
          RunsRepo.finish(runId, { autoInstallAttempts })
          broadcast({ type: 'run:auto-install', runId, attempt })
          finalizeCancelled(CANCEL_MESSAGE)
          return
        }
        if (install.exitCode === 0 && !install.timedOut) {
          attempt.success = true
        } else {
          attempt.error = install.timedOut
            ? '预安装超时'
            : `预安装失败 (exit code ${install.exitCode ?? 'unknown'})`
        }
      }
      autoInstallAttempts.push(attempt)
      RunsRepo.finish(runId, { autoInstallAttempts })
      broadcast({ type: 'run:auto-install', runId, attempt })
      runtimeLog.info('run_preflight_auto_install', {
        runId,
        taskId,
        success: attempt.success,
        retried: attempt.retried,
        installExitCode: attempt.installExitCode ?? null,
        error: attempt.error
      })
    }
  }

  // === spawn ===
  let stdout = ''
  let stderr = ''
  let exitCode: number | null = null
  let timedOut = false
  let cancelled = false
  const spawnStart = Date.now()

  try {
    const result = await spawnAndWait(command, { runId, taskId })
    stdout = result.stdout
    stderr = result.stderr
    exitCode = result.exitCode
    timedOut = result.timedOut
    cancelled = result.cancelled
  } catch (e) {
    const msg = (e as Error).message
    const duration = Date.now() - startMs
    log.section('Spawn Error')
    log.raw(msg)
    log.section('Finished')
    log.kv('Stage:', 'failed (spawn_error)')
    log.kv('Duration:', duration + ' ms')

    RunsRepo.finish(runId, {
      stage: 'failed',
      scriptStage: 'failed',
      aiStage: 'skipped',
      failReason: 'script_error',
      exitCode: undefined,
      endedAt: new Date().toISOString(),
      durationMs: duration,
      stderrExcerpt: msg,
      rawLogPath: rawLog
    })
    runtimeLog.error('run_failed_spawn_error', { runId, taskId, error: msg })
    broadcast({ type: 'run:finished', runId, taskId })
    return
  }

  const spawnDuration = Date.now() - spawnStart
  let duration = Date.now() - startMs
  let stdoutExcerpt = tail(stdout, STDOUT_MAX)
  let stderrExcerpt = tail(stderr, STDERR_MAX)
  if (cancelled) {
    log.section('Process Result')
    log.kv('Cancelled:', true)
    finalizeCancelled(stderrExcerpt || CANCEL_MESSAGE)
    return
  }

  const missingModule =
    isPythonScript && exitCode !== 0 && !timedOut ? parseModuleNotFound(stderr) : null
  if (missingModule && autoInstallEnabled && canInstallByEnv && !preflightInstallAttempted) {
    log.section(`Auto Install: Missing Module ${missingModule}`)
    const attempt: AutoInstallAttempt = {
      missingModule,
      retried: false,
      success: false,
      at: new Date().toISOString()
    }
    try {
      const suggestion = await analyzeMissingModule(stderr, pythonInfo as PythonInfo, command.cwd, {
        settings,
        provider: task.aiProvider ?? 'opencode',
        customSystemPrompt: task.failureAiPrompt,
        disableAi: task.failureAiEnabled === false,
        missingModuleHint: missingModule
      })
      attempt.suggestion = suggestion
      log.kv('Suggested Package:', suggestion.package_name)
      log.kv('Suggested Argv:', suggestion.install_argv)
      const allowedExec = [
        (pythonInfo as PythonInfo).pythonPath,
        (pythonInfo as PythonInfo).executable ?? '',
        command.pythonPath,
        'uv',
        'uv.exe'
      ].filter(Boolean)
      if (!suggestion.safe) {
        attempt.error = 'AI 判定命令不安全'
      } else if (!isInstallArgvSafe(suggestion.install_argv, allowedExec)) {
        attempt.error = '命令未通过本地白名单校验'
      } else {
        const approved = askInstallConfirmation({
          taskName: task.name,
          runId,
          missing: suggestion.package_name || missingModule,
          argv: suggestion.install_argv
        })
        if (!approved) {
          attempt.error = '用户拒绝安装'
          autoInstallAttempts.push(attempt)
          RunsRepo.finish(runId, { autoInstallAttempts })
          broadcast({ type: 'run:auto-install', runId, attempt })
          runtimeLog.info('run_post_fail_auto_install_rejected', {
            runId,
            taskId,
            packageName: suggestion.package_name || missingModule
          })
          finalizeCancelled('用户拒绝依赖安装')
          return
        }
        const installCommand: RunCommand = {
          pythonPath: suggestion.install_argv[0],
          scriptPath: '<pip-install>',
          argv: suggestion.install_argv,
          cwd: command.cwd,
          timeoutSec: 300,
          inputFile: command.inputFile,
          env: command.env
        }
        const install = await spawnAndWait(installCommand, { runId, taskId })
        attempt.installExitCode = install.exitCode ?? undefined
        attempt.installStdoutTail = tail(install.stdout, 2000)
        attempt.installStderrTail = tail(install.stderr, 2000)
        if (install.cancelled) {
          attempt.error = CANCEL_MESSAGE
          autoInstallAttempts.push(attempt)
          RunsRepo.finish(runId, { autoInstallAttempts })
          broadcast({ type: 'run:auto-install', runId, attempt })
          finalizeCancelled(CANCEL_MESSAGE)
          return
        }
        if (install.exitCode === 0 && !install.timedOut) {
          attempt.retried = true
          const retried = await spawnAndWait(command, { runId, taskId })
          stdout = retried.stdout
          stderr = retried.stderr
          exitCode = retried.exitCode
          timedOut = retried.timedOut
          if (retried.cancelled) {
            attempt.error = CANCEL_MESSAGE
            autoInstallAttempts.push(attempt)
            RunsRepo.finish(runId, { autoInstallAttempts })
            broadcast({ type: 'run:auto-install', runId, attempt })
            finalizeCancelled(CANCEL_MESSAGE)
            return
          }
          attempt.success = retried.exitCode === 0 && !retried.timedOut
        } else {
          attempt.error = install.timedOut
            ? 'pip install 超时'
            : `pip install 失败 (exit ${install.exitCode ?? 'unknown'})`
        }
      }
    } catch (e) {
      attempt.error = `自动安装流程异常: ${(e as Error).message}`
    }
    autoInstallAttempts.push(attempt)
    RunsRepo.finish(runId, { autoInstallAttempts })
    broadcast({ type: 'run:auto-install', runId, attempt })
    runtimeLog.info('run_post_fail_auto_install', {
      runId,
      taskId,
      success: attempt.success,
      retried: attempt.retried,
      installExitCode: attempt.installExitCode ?? null,
      error: attempt.error
    })
    duration = Date.now() - startMs
    stdoutExcerpt = tail(stdout, STDOUT_MAX)
    stderrExcerpt = tail(stderr, STDERR_MAX)
  } else if (missingModule && !autoInstallEnabled) {
    log.section('Auto Install Skipped')
    log.kv('Reason:', 'autoInstallEnabled=false')
  } else if (missingModule && !canInstallByEnv) {
    log.section('Auto Install Skipped')
    log.kv(
      'Reason:',
      `当前环境不支持自动安装 (envKind=${(pythonInfo as PythonInfo).envKind}, pipAvailable=${String(!!(pythonInfo as PythonInfo).pipAvailable)})`
    )
  } else if (missingModule && preflightInstallAttempted) {
    log.section('Auto Install Skipped')
    log.kv('Reason:', '已在运行前尝试过预安装，本轮不重复安装')
  }

  log.section('Process Result')
  log.kv('Exit Code:', exitCode)
  log.kv('Timed Out:', timedOut)
  log.kv('Spawn Duration:', spawnDuration + ' ms')

  log.section(`stdout (${stdout.length} bytes)`)
  log.raw(stdout || '(empty)')

  log.section(`stderr (${stderr.length} bytes)`)
  log.raw(stderr || '(empty)')

  if (timedOut) {
    const failureAi = task.failureAiEnabled === false
      ? { summary: '脚本执行超时', need_notify: false }
      : await analyzeFailureReason({
          settings,
          provider: task.aiProvider ?? 'opencode',
          taskName: task.name,
          failReason: 'timeout',
          exitCode: exitCode ?? undefined,
          stdoutTail: stdoutExcerpt,
          stderrTail: stderrExcerpt,
          customPrompt: task.failureAiPrompt,
          runId
        })
    log.section('Finished')
    log.kv('Stage:', 'failed (timeout)')
    log.kv('Total Duration:', duration + ' ms')
    RunsRepo.finish(runId, {
      stage: 'failed',
      scriptStage: 'failed',
      aiStage: task.failureAiEnabled === false ? 'skipped' : 'done',
      failReason: 'timeout',
      exitCode: exitCode ?? undefined,
      endedAt: new Date().toISOString(),
      durationMs: duration,
      stdoutExcerpt,
      stderrExcerpt,
      rawLogPath: rawLog,
      aiResultJson: failureAi,
      nextRetryAt: undefined
    })
    runtimeLog.warn('run_failed_timeout', { runId, taskId, durationMs: duration })
    maybeNotifyFailure(task, runId, taskId, 'timeout', task.notifyOnTimeout !== false, failureAi)
    queueRetryIfNeeded(task, args, runId, retryLeft)
    broadcast({ type: 'run:finished', runId, taskId })
    return
  }

  if (exitCode !== 0) {
    const failureAi = task.failureAiEnabled === false
      ? { summary: '脚本执行失败（非 0 退出码）', need_notify: false }
      : await analyzeFailureReason({
          settings,
          provider: task.aiProvider ?? 'opencode',
          taskName: task.name,
          failReason: 'script_error',
          exitCode: exitCode ?? undefined,
          stdoutTail: stdoutExcerpt,
          stderrTail: stderrExcerpt,
          customPrompt: task.failureAiPrompt,
          runId
        })
    log.section('Finished')
    log.kv('Stage:', 'failed (script_error, non-zero exit)')
    log.kv('Total Duration:', duration + ' ms')
    RunsRepo.finish(runId, {
      stage: 'failed',
      scriptStage: 'failed',
      aiStage: task.failureAiEnabled === false ? 'skipped' : 'done',
      failReason: 'script_error',
      exitCode: exitCode ?? undefined,
      endedAt: new Date().toISOString(),
      durationMs: duration,
      stdoutExcerpt,
      stderrExcerpt,
      rawLogPath: rawLog,
      aiResultJson: failureAi,
      nextRetryAt: undefined
    })
    runtimeLog.warn('run_failed_script_error', {
      runId,
      taskId,
      exitCode: exitCode ?? null,
      durationMs: duration
    })
    maybeNotifyFailure(task, runId, taskId, 'script_error', task.notifyOnFailure !== false)
    queueRetryIfNeeded(task, args, runId, retryLeft)
    broadcast({ type: 'run:finished', runId, taskId })
    return
  }

  const parsed = tryParseJson(stdout)
  const scriptOutput = parsed.ok ? parsed.parsed : stdout

  log.section('Parsed Script Output')
  log.kv('JSON Parse:', parsed.ok ? 'success' : 'failed (treated as raw text)')
  if (parsed.ok) log.raw(JSON.stringify(parsed.parsed, null, 2))

  const promptCtx = {
    task,
    run: { runId, exitCode: exitCode ?? 0, durationMs: duration },
    args,
    scriptOutput,
    stdout: stdoutExcerpt,
    stderr: stderrExcerpt
  }
  if (task.aiEnabled === false) {
    log.section('AI Call')
    log.kv('AI Status:', 'skipped (task.aiEnabled=false)')
    let notified = false
    if (task.notifyEnabled) {
      const title = `任务完成：${task.name}`
      const body = '该任务未启用 AI 分析，脚本已执行完成'
      showNotification(title, body)
      const notif = NotificationsRepo.create({ runId, taskId, title, body })
      broadcast({ type: 'notification:new', id: notif.id })
      notified = true
      log.kv('Notification:', 'sent (task setting)')
    } else {
      log.kv('Notification:', 'skipped (task muted)')
    }
    log.section('Finished')
    log.kv('Stage:', 'done')
    log.kv('Total Duration:', duration + ' ms')
    RunsRepo.finish(runId, {
      stage: 'done',
      scriptStage: 'done',
      aiStage: 'skipped',
      exitCode: exitCode ?? 0,
      endedAt: new Date().toISOString(),
      durationMs: duration,
      stdoutExcerpt,
      stderrExcerpt,
      rawLogPath: rawLog,
      scriptOutputJson: scriptOutput,
      aiResultJson: {
        summary: '该任务未启用 AI 分析',
        need_notify: false
      },
      notified,
      nextRetryAt: undefined
    })
    runtimeLog.info('run_done_no_ai', { runId, taskId, durationMs: duration, notified })
    broadcast({ type: 'run:finished', runId, taskId })
    return
  }

  const sysRender = renderTemplate(task.systemPrompt, promptCtx)
  const userRender = renderTemplate(task.userPromptTemplate, promptCtx)
  const renderedPrompt = `=== System ===\n${sysRender.rendered}\n\n=== User ===\n${userRender.rendered}`

  log.section('Prompt Rendered')
  log.kv('System (bytes):', sysRender.rendered.length)
  log.kv('User (bytes):', userRender.rendered.length)
  if (sysRender.missingVars.length || userRender.missingVars.length) {
    log.kv(
      'Missing Vars:',
      Array.from(new Set([...sysRender.missingVars, ...userRender.missingVars]))
    )
  }

  log.section('AI Call')
  const ocStatus = opencode.getStatus()
  log.kv('opencode URL:', ocStatus.baseUrl ?? '(未就绪)')
  log.kv('opencode State:', ocStatus.state)
  const aiStart = Date.now()
  RunsRepo.finish(runId, { scriptStage: 'done', aiStage: 'running' })

  try {
    const aiOut = await callAi({
      settings,
      provider: task.aiProvider ?? 'opencode',
      systemPrompt: sysRender.rendered,
      userPrompt: userRender.rendered,
      runId
    })
    const aiResult = aiOut.result
    const aiDuration = Date.now() - aiStart
    log.kv('AI Duration:', aiDuration + ' ms')
    log.kv('AI Status:', 'success')

    log.section('AI Result')
    log.kv('summary:', aiResult.summary)
    log.kv('need_notify:', String(aiResult.need_notify === true))
    if (aiResult.notify_title) log.kv('notify_title:', aiResult.notify_title)
    if (aiResult.notify_body) log.kv('notify_body:', aiResult.notify_body)
    if (aiResult.details) {
      log.section('AI Details')
      log.raw(aiResult.details)
    }

    let notified = false
    const shouldNotify = task.notifyEnabled && aiResult.need_notify === true
    if (shouldNotify) {
      const title = aiResult.notify_title?.trim() || `任务完成：${task.name}`
      const body = aiResult.notify_body?.trim() || aiResult.summary
      showNotification(title, body)
      const notif = NotificationsRepo.create({
        runId,
        taskId,
        title,
        body
      })
      broadcast({ type: 'notification:new', id: notif.id })
      notified = true
      log.kv('Notification:', 'sent (AI need_notify=true)')
    } else if (!task.notifyEnabled) {
      log.kv('Notification:', 'skipped (task muted)')
    } else {
      log.kv('Notification:', 'skipped (AI need_notify=false)')
    }

    log.section('Finished')
    log.kv('Stage:', 'done')
    log.kv('Total Duration:', duration + ' ms')

    RunsRepo.finish(runId, {
      stage: 'done',
      scriptStage: 'done',
      aiStage: 'done',
      exitCode: exitCode ?? 0,
      endedAt: new Date().toISOString(),
      durationMs: duration,
      stdoutExcerpt,
      stderrExcerpt,
      rawLogPath: rawLog,
      scriptOutputJson: scriptOutput,
      renderedPrompt,
      aiResultJson: aiResult,
      aiRawResponse: aiOut.raw,
      notified,
      nextRetryAt: undefined
    })
    runtimeLog.info('run_done_ai', { runId, taskId, durationMs: duration, notified })
  } catch (e) {
    const aiDuration = Date.now() - aiStart
    log.kv('AI Duration:', aiDuration + ' ms')
    log.kv('AI Status:', 'error')
    log.kv('AI Error:', (e as Error).message)

    const fallbackSummary = '脚本执行完成，但 AI 分析失败，请查看运行日志'
    log.section('Finished')
    log.kv('Stage:', 'done (ai_fallback)')
    log.kv('Total Duration:', duration + ' ms')

    RunsRepo.finish(runId, {
      stage: 'done',
      scriptStage: 'done',
      aiStage: 'failed',
      failReason: undefined,
      exitCode: exitCode ?? 0,
      endedAt: new Date().toISOString(),
      durationMs: duration,
      stdoutExcerpt,
      stderrExcerpt,
      rawLogPath: rawLog,
      scriptOutputJson: scriptOutput,
      renderedPrompt,
      aiRawResponse: undefined,
      aiError: (e as Error).message,
      aiResultJson: {
        summary: fallbackSummary,
        need_notify: false,
        details: (e as Error).message
      },
      nextRetryAt: undefined
    })
    runtimeLog.warn('run_done_ai_fallback', {
      runId,
      taskId,
      durationMs: duration,
      aiError: (e as Error).message
    })
    maybeNotifyFailure(task, runId, taskId, 'ai_error', task.notifyOnFailure !== false)
  }

  broadcast({ type: 'run:finished', runId, taskId })
}

function maybeNotifyFailure(
  task: Task,
  runId: string,
  taskId: string,
  reason: 'timeout' | 'script_error' | 'ai_error',
  enabled: boolean,
  aiResult?: { need_notify?: boolean; notify_title?: string; notify_body?: string }
): void {
  // If AI result is provided, use its notification preferences
  if (aiResult !== undefined) {
    const shouldNotify = enabled && aiResult.need_notify === true
    if (!shouldNotify) return
    
    const title = aiResult.notify_title?.trim() || `任务完成：${task.name}`
    const body = aiResult.notify_body?.trim() || `运行 ID ${runId} 失败（原因: ${reason}）`
    showNotification(title, body)
    const notif = NotificationsRepo.create({ runId, taskId, title, body })
    broadcast({ type: 'notification:new', id: notif.id })
    return
  }
  
  // Fallback to original behavior for backward compatibility
  if (!enabled) return
  const title =
    reason === 'timeout'
      ? `任务执行超时: ${task.name}`
      : reason === 'ai_error'
        ? `AI 分析失败: ${task.name}`
        : `任务执行失败: ${task.name}`
  const body = `运行 ID ${runId} 失败（原因: ${reason}）`
  showNotification(title, body)
  const notif = NotificationsRepo.create({ runId, taskId, title, body })
  broadcast({ type: 'notification:new', id: notif.id })
}

function queueRetryIfNeeded(
  task: Task,
  args: Record<string, unknown>,
  runId: string,
  retryLeft: number
): void {
  if (retryLeft <= 0) return
  const delaySec = Math.max(1, task.retryDelaySec ?? 15)
  const nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString()
  RunsRepo.finish(runId, { nextRetryAt })
  runtimeLog.info('run_retry_queued', {
    runId,
    taskId: task.id,
    retryLeft,
    delaySec,
    nextRetryAt
  })
  const title = `任务已进入自动重试队列: ${task.name}`
  const body = `来源运行 ID ${runId}，将在 ${delaySec} 秒后重试，剩余 ${retryLeft} 次`
  showNotification(title, body)
  // 由 scheduler 持久化扫描 nextRetryAt 触发，避免进程重启后丢失重试
}

/** 只重试 AI 那一步，不重跑脚本。沿用上次的 stdout/stderr。 */
export async function retryAi(runId: string): Promise<Run> {
  const run = RunsRepo.get(runId)
  if (!run) throw new Error(`运行记录不存在: ${runId}`)
  const task = TasksRepo.get(run.taskId)
  if (!task) throw new Error(`任务不存在: ${run.taskId}`)
  if (task.aiEnabled === false) throw new Error('当前任务未启用 AI 分析')
  runtimeLog.info('retry_ai_start', { runId, taskId: run.taskId, taskName: task.name })

  const settings = SettingsRepo.get()
  const ctx = {
    task,
    run,
    args: run.inputArgs,
    scriptOutput: run.scriptOutputJson,
    stdout: run.stdoutExcerpt ?? '',
    stderr: run.stderrExcerpt ?? ''
  }
  const sys = renderTemplate(task.systemPrompt, ctx)
  const usr = renderTemplate(task.userPromptTemplate, ctx)
  const renderedPrompt = `=== System ===\n${sys.rendered}\n\n=== User ===\n${usr.rendered}`

  const appendLog = (k: string, v: unknown) => {
    if (run.rawLogPath && fs.existsSync(run.rawLogPath)) {
      fs.appendFileSync(run.rawLogPath, `${k.padEnd(16)}${fmt(v)}\n`)
    }
  }
  const appendSection = (t: string) => {
    if (run.rawLogPath && fs.existsSync(run.rawLogPath)) {
      fs.appendFileSync(run.rawLogPath, `\n[${new Date().toISOString()}] === ${t} ===\n`)
    }
  }

  appendSection('AI Retry')
  const ocStatus = opencode.getStatus()
  appendLog('opencode URL:', ocStatus.baseUrl ?? '(未就绪)')
  appendLog('opencode State:', ocStatus.state)
  const aiStart = Date.now()

  try {
    const aiOut = await callAi({
      settings,
      provider: task.aiProvider ?? 'opencode',
      systemPrompt: sys.rendered,
      userPrompt: usr.rendered,
      runId
    })
    const aiResult = aiOut.result
    appendLog('AI Duration:', Date.now() - aiStart + ' ms')
    appendLog('AI Status:', 'success')
    appendLog('summary:', aiResult.summary)
    appendLog('need_notify:', String(aiResult.need_notify === true))

    let notified = run.notified
    if (!notified && task.notifyEnabled && aiResult.need_notify === true) {
      const title = aiResult.notify_title?.trim() || `任务完成：${task.name}`
      const body = aiResult.notify_body?.trim() || aiResult.summary
      showNotification(title, body)
      const notif = NotificationsRepo.create({
        runId,
        taskId: run.taskId,
        title,
        body
      })
      broadcast({ type: 'notification:new', id: notif.id })
      notified = true
    }
    const updated = RunsRepo.finish(runId, {
      stage: 'done',
      scriptStage: 'done',
      aiStage: 'done',
      renderedPrompt,
      aiResultJson: aiResult,
      aiRawResponse: aiOut.raw,
      aiError: undefined,
      failReason: undefined,
      notified
    })
    runtimeLog.info('retry_ai_done', { runId, taskId: run.taskId, notified })
    if (!updated) throw new Error('运行记录更新失败')
    broadcast({ type: 'run:finished', runId, taskId: run.taskId })
    return updated
  } catch (e) {
    appendLog('AI Duration:', Date.now() - aiStart + ' ms')
    appendLog('AI Status:', 'error')
    appendLog('AI Error:', (e as Error).message)

    const updated = RunsRepo.finish(runId, {
      scriptStage: 'done',
      aiStage: 'failed',
      renderedPrompt,
      aiError: (e as Error).message,
      aiResultJson: {
        summary: '脚本执行完成，但 AI 重试失败',
        details: (e as Error).message,
        need_notify: false
      }
    })
    runtimeLog.warn('retry_ai_failed', {
      runId,
      taskId: run.taskId,
      error: (e as Error).message
    })
    if (!updated) throw new Error('运行记录更新失败')
    broadcast({ type: 'run:finished', runId, taskId: run.taskId })
    return updated
  }
}
