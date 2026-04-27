// 共享类型：main 和 renderer 都用

export type RunStage = 'running' | 'done' | 'failed'
export type AiStage = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type AiProvider = 'opencode' | 'openai'
export interface OpenAiHeaderItem {
  key: string
  value: string
  enabled?: boolean
}
export interface OpenAiConnectionTestResult {
  ok: boolean
  status: number
  model?: string
  latencyMs: number
  message: string
}
export type FailReason =
  | 'script_error'
  | 'timeout'
  | 'bad_output'
  | 'ai_error'
  | 'python_missing'
  | 'cancelled'

export interface ArgDef {
  type: 'string' | 'number' | 'boolean' | 'enum'
  required?: boolean
  default?: unknown
  description?: string
  enumValues?: string[]
}

export interface Task {
  id: string
  name: string
  /** 任务标签（单标签） */
  tag?: string
  description?: string
  scriptPath: string
  argsSchema: Record<string, ArgDef>
  timeoutSec: number
  scheduleEnabled?: boolean
  scheduleEveryMin?: number
  retryCount?: number
  retryDelaySec?: number
  notifyOnFailure?: boolean
  notifyOnTimeout?: boolean
  lastScheduledAt?: string
  /** 成功后是否启用 AI 推理 */
  aiEnabled: boolean
  /** 成功后 AI 的用户提示词模板 */
  systemPrompt: string
  userPromptTemplate: string
  /** AI 提供方：opencode（可 agent）/ openai（仅分析） */
  aiProvider?: AiProvider
  /** 失败后是否启用 AI 诊断（依赖建议/失败原因） */
  failureAiEnabled?: boolean
  /** 失败后 AI 诊断提示词（留空用系统默认） */
  failureAiPrompt?: string
  notifyEnabled: boolean
  createdAt: string
  updatedAt: string
}

export type TaskInput = Omit<Task, 'id' | 'createdAt' | 'updatedAt'>
export type TaskPatch = Partial<TaskInput>

export interface AiResult {
  summary: string
  details?: string
  need_notify: boolean
  notify_title?: string
  notify_body?: string
}

export interface Run {
  runId: string
  taskId: string
  inputArgs: Record<string, unknown>
  /** 脚本执行状态（不包含 AI） */
  scriptStage?: RunStage
  /** AI 分析状态 */
  aiStage?: AiStage
  stage: RunStage
  failReason?: FailReason
  exitCode?: number
  startedAt: string
  endedAt?: string
  durationMs?: number
  stdoutExcerpt?: string
  stderrExcerpt?: string
  rawLogPath?: string
  scriptOutputJson?: unknown
  renderedPrompt?: string
  aiResultJson?: AiResult
  aiRawResponse?: string
  aiError?: string
  notified: boolean

  /** 运行命令详情（老记录可能没有） */
  command?: RunCommand
  autoInstallAttempts?: AutoInstallAttempt[]
  trigger?: RunTrigger
  retryLeft?: number
  sourceRunId?: string
  nextRetryAt?: string
}

export type RunTrigger = 'manual' | 'schedule' | 'retry'

/** 一次运行的实际执行命令详情 */
export interface RunCommand {
  /** 实际执行器路径（python/cmd/powershell） */
  pythonPath: string
  /** 脚本绝对路径 */
  scriptPath: string
  /** 完整命令行（第 1 项为执行器） */
  argv: string[]
  /** 子进程工作目录 */
  cwd: string
  /** 超时时间（秒） */
  timeoutSec: number
  /** input.json 文件路径（参数快照） */
  inputFile: string
  /** 我们显式设置的环境变量（不包括继承的 process.env） */
  env: Record<string, string>
}

export interface NotificationItem {
  id: string
  runId: string
  taskId: string
  title: string
  body: string
  read: boolean
  createdAt: string
}

/**
 * 应用设置。
 *
 * 从 v0.2 起 AI 调用走 opencode 本地进程，由主进程自动拉起。
 * 因此不再需要 URL / 模型名这些字段；模型在 opencode 自己的 config 里配。
 */
export interface Settings {
  /** Python 可执行文件路径 */
  pythonPath: string
  /** opencode 可执行文件路径。留空 = 用 PATH 里的 opencode */
  opencodeBinPath: string
  /** opencode 监听端口 */
  opencodePort?: number
  /** OpenAI 兼容 API 基址 */
  openaiBaseUrl?: string
  /** OpenAI 兼容 API Key */
  openaiApiKey?: string
  /** OpenAI 兼容模型名 */
  openaiModel?: string
  /** OpenAI 请求超时（秒） */
  openaiTimeoutSec?: number
  /** OpenAI 兼容接口自定义 Header 列表 */
  openaiHeaders?: OpenAiHeaderItem[]
  /** 缺包时是否自动尝试安装并重跑 */
  autoInstallEnabled?: boolean
  /** 小球右键的一键命令列表 */
  quickCommands?: Array<{ name: string; command: string; cwd?: string }>
  /** 是否启用脚本服务器 */
  scriptServerEnabled?: boolean
  /** 脚本服务器地址 */
  scriptServerBaseUrl?: string
  /** 是否已完成首次引导 */
  onboardingDone?: boolean
}

/** opencode 子进程状态（main → renderer） */
export interface OpencodeStatus {
  state: 'stopped' | 'starting' | 'ready' | 'crashed' | 'missing'
  port?: number
  baseUrl?: string
  pid?: number
  lastError?: string
  startedAt?: string
}

export interface PromptPreview {
  systemPrompt: string
  userPrompt: string
  missingVars: string[]
}

/** 上传脚本返回结构 */
export interface UploadedScript {
  /** tasks/ 目录下的相对路径，可直接写入 Task.scriptPath */
  fileName: string
  absolutePath: string
  size: number
  /** 是否覆盖了同名已有文件 */
  overwritten: boolean
}

export interface RemoteScriptItem {
  fileName: string
  summary: string
  size: number
  updatedAt: string
}

export type ArgSchemaSource = 'parser' | 'ai' | 'none'

export interface ArgSchemaGenerateResult {
  argsSchema: Record<string, ArgDef>
  source: ArgSchemaSource
  standardized: boolean
  needsDeveloperInput: boolean
  message: string
}

/** 所有 IPC 调用的统一返回形状 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** main → renderer 事件 */
export type MainEvent =
  | { type: 'run:started'; runId: string; taskId: string }
  | { type: 'run:finished'; runId: string; taskId: string }
  | { type: 'notification:new'; id: string }
  | { type: 'opencode:status'; status: OpencodeStatus }
  | { type: 'run:auto-install'; runId: string; attempt: AutoInstallAttempt }

export type PythonEnvKind = 'conda' | 'uv' | 'venv' | 'system' | 'unknown'

export interface PythonInfo {
  ok: boolean
  pythonPath: string
  version?: string
  envKind: PythonEnvKind
  envDetail?: string
  executable?: string
  prefix?: string
  basePrefix?: string
  pipAvailable?: boolean
  error?: string
  errorType?: 'not_found' | 'permission' | 'exec_failed' | 'probe_crash'
  detectedAt: string
}

export interface InstallSuggestion {
  package_name: string
  install_argv: string[]
  reasoning: string
  safe: boolean
}

export interface AutoInstallAttempt {
  missingModule: string
  suggestion?: InstallSuggestion
  installExitCode?: number
  installStdoutTail?: string
  installStderrTail?: string
  retried: boolean
  success: boolean
  error?: string
  at: string
}
