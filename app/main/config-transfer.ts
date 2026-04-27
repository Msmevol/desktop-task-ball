import type { ArgDef, Settings, TaskInput } from '@shared/types'

type ImportPayload = {
  tasks?: unknown
  settings?: unknown
}

const DEFAULT_SYSTEM_PROMPT = `你是任务推理助手。
目标：基于任务上下文与脚本结果，给出可执行结论，不编造事实。
输出协议：只输出 JSON，字段为 summary, details, notify_title, notify_body。
其中 details 使用 Markdown，优先给结论、证据、建议。`

const DEFAULT_USER_PROMPT = `任务: {{task.name}}
退出码: {{run.exitCode}}
耗时(ms): {{run.durationMs}}

参数:
{{args}}

脚本输出:
{{scriptOutput}}

错误输出:
{{stderr}}`

const DEFAULT_FAILURE_AI_PROMPT = `你是任务失败诊断助手。
目标：当任务失败时，给出可执行结论。
规则：
1) 若失败是缺少包（如 ModuleNotFoundError），系统会在用户确认后按 Python 环境安装缺失依赖并重试任务。你需要说明安装与重试结果。
2) 若不是缺包失败，分析脚本失败原因，并给出明确的脚本修改建议（包含修改方向/示例思路）。
输出协议：只输出 JSON，字段为 summary, details, notify_title, notify_body。
details 使用 Markdown，固定三段：
## 根因判断
## 修改建议
## 验证步骤`

export interface ImportPlan {
  tasks: TaskInput[]
  settings: Partial<Settings>
  skipped: number
  warnings: string[]
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  return fallback
}

function asNum(v: unknown, fallback: number, min = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.floor(n))
}

function asPort(v: unknown, fallback: number): number {
  const n = asNum(v, fallback, 1)
  return Math.min(65535, n)
}

function isSupportedScriptPath(v: string): boolean {
  const s = v.toLowerCase()
  return s.endsWith('.py') || s.endsWith('.bat') || s.endsWith('.cmd') || s.endsWith('.ps1')
}

function normalizeTask(raw: unknown): TaskInput | null {
  const r = asRecord(raw)
  if (!r) return null
  const name = String(r.name ?? '').trim()
  const scriptPath = String(r.scriptPath ?? '').trim()
  const argsSchema = (asRecord(r.argsSchema) ?? {}) as Record<string, ArgDef>
  const aiEnabled = asBool(r.aiEnabled, true)
  const systemPrompt = String(r.systemPrompt ?? '').trim() || DEFAULT_SYSTEM_PROMPT
  const userPromptTemplate = String(r.userPromptTemplate ?? '').trim() || DEFAULT_USER_PROMPT
  if (!name || !scriptPath || !isSupportedScriptPath(scriptPath)) return null

  return {
    name,
    tag: String(r.tag ?? '').trim() || undefined,
    description: r.description ? String(r.description) : undefined,
    scriptPath,
    argsSchema,
    timeoutSec: asNum(r.timeoutSec, 600, 1),
    scheduleEnabled: asBool(r.scheduleEnabled, false),
    scheduleEveryMin: asNum(r.scheduleEveryMin, 60, 1),
    retryCount: asNum(r.retryCount, 0, 0),
    retryDelaySec: asNum(r.retryDelaySec, 15, 1),
    notifyOnFailure: asBool(r.notifyOnFailure, true),
    notifyOnTimeout: asBool(r.notifyOnTimeout, true),
    aiEnabled,
    aiProvider: r.aiProvider === 'openai' ? 'openai' : 'opencode',
    failureAiEnabled: asBool(r.failureAiEnabled, true),
    failureAiPrompt: String(r.failureAiPrompt ?? '').trim() || DEFAULT_FAILURE_AI_PROMPT,
    systemPrompt,
    userPromptTemplate,
    notifyEnabled: asBool(r.notifyEnabled, true)
  }
}

function normalizeSettings(raw: unknown): Partial<Settings> {
  const s = asRecord(raw)
  if (!s) return {}
  const out: Partial<Settings> = {}
  if (typeof s.pythonPath === 'string' && s.pythonPath.trim()) out.pythonPath = s.pythonPath.trim()
  if (typeof s.opencodeBinPath === 'string') out.opencodeBinPath = s.opencodeBinPath.trim()
  if (s.opencodePort !== undefined) out.opencodePort = asPort(s.opencodePort, 4097)
  if (typeof s.openaiBaseUrl === 'string') out.openaiBaseUrl = s.openaiBaseUrl.trim()
  if (typeof s.openaiApiKey === 'string') out.openaiApiKey = s.openaiApiKey.trim()
  if (typeof s.openaiModel === 'string') out.openaiModel = s.openaiModel.trim()
  if (s.openaiTimeoutSec !== undefined) out.openaiTimeoutSec = asNum(s.openaiTimeoutSec, 60, 1)
  if (Array.isArray(s.openaiHeaders)) {
    const used = new Set<string>()
    const headers: Array<{ key: string; value: string; enabled: boolean }> = []
    for (const x of s.openaiHeaders) {
        const r = asRecord(x)
        if (!r) continue
        const key = String(r.key ?? '').trim()
        if (!key) continue
        const lower = key.toLowerCase()
        if (used.has(lower)) continue
        used.add(lower)
        headers.push({
          key,
          value: String(r.value ?? ''),
          enabled: r.enabled === false ? false : true
        })
    }
    out.openaiHeaders = headers
  }
  if (typeof s.autoInstallEnabled === 'boolean') out.autoInstallEnabled = s.autoInstallEnabled
  if (typeof s.scriptServerEnabled === 'boolean') out.scriptServerEnabled = s.scriptServerEnabled
  if (typeof s.scriptServerBaseUrl === 'string') out.scriptServerBaseUrl = s.scriptServerBaseUrl.trim()
  if (Array.isArray(s.quickCommands)) {
    out.quickCommands = s.quickCommands
      .map((x) => {
        const r = asRecord(x)
        if (!r) return null
        const name = String(r.name ?? '').trim()
        const command = String(r.command ?? '').trim()
        if (!name || !command) return null
        const cwd = typeof r.cwd === 'string' && r.cwd.trim() ? r.cwd.trim() : undefined
        return cwd ? { name, command, cwd } : { name, command }
      })
      .filter(
        (x): x is { name: string; command: string; cwd?: string } => x !== null
      )
  } else if (typeof s.quickCommand === 'string' && s.quickCommand.trim()) {
    out.quickCommands = [
      {
        name:
          typeof s.quickCommandName === 'string' && s.quickCommandName.trim()
            ? s.quickCommandName.trim()
            : '快捷命令',
        command: s.quickCommand.trim(),
        cwd: typeof s.quickCommandCwd === 'string' && s.quickCommandCwd.trim() ? s.quickCommandCwd.trim() : undefined
      }
    ]
  }
  if (typeof s.onboardingDone === 'boolean') out.onboardingDone = s.onboardingDone
  return out
}

export function buildImportPlan(payload: ImportPayload): ImportPlan {
  const tasksRaw = Array.isArray(payload.tasks) ? payload.tasks : []
  const tasks: TaskInput[] = []
  const warnings: string[] = []
  let skipped = 0
  for (const item of tasksRaw) {
    const normalized = normalizeTask(item)
    if (!normalized) {
      skipped++
      continue
    }
    tasks.push(normalized)
  }
  if (skipped > 0)
    warnings.push(`已跳过 ${skipped} 条无效任务（缺少 name/scriptPath 或脚本类型不受支持）`)
  return {
    tasks,
    settings: normalizeSettings(payload.settings),
    skipped,
    warnings
  }
}
