import type {
  AiProvider,
  AiResult,
  InstallSuggestion,
  OpenAiConnectionTestResult,
  PythonInfo,
  Settings
} from '@shared/types'
import { opencode } from './opencode'
import { buildDefaultInstallCmd, moduleToPackageName, parseModuleNotFound } from './python'
import { runtimeLog } from './logger'
const RESERVED_OPENAI_HEADER_KEYS = new Set(['authorization', 'content-type'])

interface CallAiInput {
  settings: Settings
  provider?: AiProvider
  systemPrompt: string
  userPrompt: string
  runId?: string
}
export interface AiCallOutput {
  result: AiResult
  raw: string
}

interface FailureAiInput {
  settings: Settings
  provider?: AiProvider
  taskName: string
  failReason: string
  exitCode?: number
  stdoutTail: string
  stderrTail: string
  customPrompt?: string
  runId?: string
}

interface AnalyzeMissingOpts {
  settings?: Settings
  provider?: AiProvider
  customSystemPrompt?: string
  disableAi?: boolean
  missingModuleHint?: string | null
}

let aiQueueTail: Promise<void> = Promise.resolve()

function enqueueAiCall<T>(
  purpose: string,
  runId: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  const enqueuedAt = Date.now()
  const run = aiQueueTail
    .catch(() => undefined)
    .then(async () => {
      const waitedMs = Date.now() - enqueuedAt
      runtimeLog.info('ai_queue_enter', { purpose, runId, waitedMs })
      try {
        const out = await work()
        runtimeLog.info('ai_queue_leave', { purpose, runId, ok: true })
        return out
      } catch (e) {
        runtimeLog.warn('ai_queue_leave', {
          purpose,
          runId,
          ok: false,
          error: (e as Error).message
        })
        throw e
      }
    })
  aiQueueTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * 调用 opencode session API。
 *
 * 设计:
 * - opencode 已由主进程启动时自动拉起 (见 opencode.ts)
 * - 如果调用时发现未就绪，尝试重新启动
 * - 不指定 providerID/modelID，让 opencode 使用它 config 里的默认模型
 *   (即用户在 opencode 自己的配置里选的默认 provider/model)
 */
export async function callAi({
  settings,
  provider = 'opencode',
  systemPrompt,
  userPrompt,
  runId
}: CallAiInput): Promise<AiCallOutput> {
  const runIdRule = runId
    ? `\n另外必须包含字段 run_id，且值必须严格等于 "${runId}"。`
    : ''
  const composedUser =
    `${userPrompt.trim()}\n\n---\n\n` +
    `请只输出一个 JSON 对象（不要 markdown 代码块），字段为 run_id, summary, details, need_notify, notify_title, notify_body。\n` +
    `need_notify 必须是 boolean；只有确实需要提醒用户时才为 true。\n` +
    `其中 details 使用 Markdown，建议包含：结论、关键证据、下一步建议。` +
    runIdRule
  const content =
    provider === 'openai'
      ? await callOpenAiCompatible(systemPrompt, composedUser, {
          settings,
          runId,
          purpose: 'call_ai'
        })
      : await callOpencodeSession(systemPrompt, composedUser, {
          settings,
          runId,
          purpose: 'call_ai'
        })
  return { result: parseAiJson(content, runId), raw: content }
}

async function callOpencodeSession(
  systemPrompt: string,
  userPrompt: string,
  opts?: { settings?: Settings; runId?: string; purpose?: string }
): Promise<string> {
  const purpose = opts?.purpose ?? 'opencode_call'
  const runId = opts?.runId
  return enqueueAiCall(purpose, runId, async () => {
    const status = opencode.getStatus()
    let baseUrl = status.baseUrl
    if (status.state !== 'ready' || !baseUrl) {
      baseUrl = await opencode.start(
        opts?.settings?.opencodeBinPath || 'opencode',
        opts?.settings?.opencodePort
      )
    }

    // 1) 创建会话
    const sessResp = await fetch(baseUrl + '/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    if (!sessResp.ok) {
      const body = await sessResp.text().catch(() => '')
      throw new Error(
        `opencode POST /session 返回 ${sessResp.status}: ${body.slice(0, 500)}`
      )
    }
    const sess = (await sessResp.json()) as { id?: string; sessionID?: string }
    const sessionId = sess.id ?? sess.sessionID
    if (!sessionId) {
      throw new Error(
        `opencode /session 返回体缺 id 字段: ${JSON.stringify(sess).slice(0, 300)}`
      )
    }
    runtimeLog.info('ai_session_created', { purpose, runId, sessionId })

    const composedText = `${systemPrompt.trim()}\n\n---\n\n${userPrompt.trim()}`

    const msgBody: Record<string, unknown> = {
      parts: [{ type: 'text', text: composedText }]
    }

    const msgResp = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgBody)
    })
    if (!msgResp.ok) {
      const errText = await msgResp.text().catch(() => '')
      throw new Error(
        `opencode POST /session/${sessionId}/message 返回 ${msgResp.status}: ${errText.slice(0, 800)}`
      )
    }

    const reply = (await msgResp.json()) as {
      parts?: Array<{ type?: string; text?: string }>
      message?: { parts?: Array<{ type?: string; text?: string }> }
      content?: string
    }

    // 不同版本 opencode 响应 shape 略有差异，多种都尝试
    const parts = reply.parts ?? reply.message?.parts ?? []
    let content = parts
      .filter((p) => (p.type === 'text' || !p.type) && p.text)
      .map((p) => p.text as string)
      .join('\n')
      .trim()

    if (!content && typeof reply.content === 'string') {
      content = reply.content.trim()
    }

    if (!content) {
      throw new Error(
        `opencode 返回没有文本内容: ${JSON.stringify(reply).slice(0, 500)}`
      )
    }
    runtimeLog.info('ai_session_message_done', {
      purpose,
      runId,
      sessionId,
      contentBytes: content.length
    })
    return content
  })
}

async function callOpenAiCompatible(
  systemPrompt: string,
  userPrompt: string,
  opts?: { settings?: Settings; runId?: string; purpose?: string }
): Promise<string> {
  const purpose = opts?.purpose ?? 'openai_call'
  const runId = opts?.runId
  return enqueueAiCall(purpose, runId, async () => {
    const settings = opts?.settings
    const { endpoint, model, controller, timeoutHandle, apiKey } = buildOpenAiRequestContext(settings)
    try {
      const payload = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' as const }
      }
      const doFetch = async (body: unknown) => {
        const headers = buildOpenAiHeaders(apiKey, settings)
        return fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        })
      }
      let resp = await doFetch(payload)
      if (!resp.ok && (resp.status === 400 || resp.status === 422)) {
        // 兼容不支持 response_format 的网关
        resp = await doFetch({
          model,
          messages: payload.messages,
          temperature: payload.temperature
        })
      }
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`OpenAI 兼容接口返回异常状态 ${resp.status}: ${errText.slice(0, 800)}`)
      }
      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
      }
      const contentRaw = json.choices?.[0]?.message?.content
      const content =
        typeof contentRaw === 'string'
          ? contentRaw.trim()
          : Array.isArray(contentRaw)
            ? contentRaw.map((x) => x?.text ?? '').join('\n').trim()
            : ''
      if (!content) throw new Error('OpenAI 兼容接口未返回可解析内容')
      runtimeLog.info('openai_compatible_done', {
        purpose,
        runId,
        endpoint,
        model,
        bytes: content.length,
        customHeaderKeys: (settings?.openaiHeaders ?? []).map((h) => h.key)
      })
      return content
    } finally {
      clearTimeout(timeoutHandle)
    }
  })
}

export async function testOpenAiConnection(
  settings: Settings
): Promise<OpenAiConnectionTestResult> {
  const startedAt = Date.now()
  const { endpoint, model, controller, timeoutHandle, apiKey } = buildOpenAiRequestContext(settings)
  try {
    const headers = buildOpenAiHeaders(apiKey, settings)
    const payload = {
      model,
      messages: [{ role: 'user', content: 'Reply with JSON: {"ok":true}' }],
      temperature: 0,
      max_tokens: 32,
      response_format: { type: 'json_object' as const }
    }
    const doFetch = async (body: unknown) =>
      fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      })
    let resp = await doFetch(payload)
    if (!resp.ok && (resp.status === 400 || resp.status === 422)) {
      // 兼容不支持 response_format 的网关
      resp = await doFetch({
        model,
        messages: payload.messages,
        temperature: payload.temperature,
        max_tokens: payload.max_tokens
      })
    }
    const latencyMs = Date.now() - startedAt
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      return {
        ok: false,
        status: resp.status,
        latencyMs,
        model,
        message: `请求失败（HTTP ${resp.status}）: ${errText.slice(0, 400)}`
      }
    }
    const json = (await resp.json()) as {
      model?: string
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
    }
    const contentRaw = json.choices?.[0]?.message?.content
    const content =
      typeof contentRaw === 'string'
        ? contentRaw.trim()
        : Array.isArray(contentRaw)
          ? contentRaw.map((x) => x?.text ?? '').join('\n').trim()
          : ''
    if (!content) {
      return {
        ok: false,
        status: resp.status,
        latencyMs,
        model: json.model ?? model,
        message: '接口可达，但未返回有效响应内容'
      }
    }
    return {
      ok: true,
      status: resp.status,
      latencyMs,
      model: json.model ?? model,
      message: `连接成功，已接收响应（${content.slice(0, 80)}）`
    }
  } finally {
    clearTimeout(timeoutHandle)
  }
}

function buildOpenAiRequestContext(settings?: Settings): {
  endpoint: string
  model: string
  controller: AbortController
  timeoutHandle: NodeJS.Timeout
  apiKey: string
} {
  const baseUrl = String(settings?.openaiBaseUrl ?? '').trim()
  const apiKey = String(settings?.openaiApiKey ?? '').trim()
  const model = String(settings?.openaiModel ?? '').trim()
  const timeoutSec = Number(settings?.openaiTimeoutSec ?? 60)
  if (!baseUrl || !apiKey || !model) {
    throw new Error('OpenAI 配置不完整，请在设置页填写 Base URL、API Key 与 Model')
  }
  const endpoint = baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '') + '/v1/chat/completions'
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(1, timeoutSec) * 1000)
  return { endpoint, model, controller, timeoutHandle, apiKey }
}

function buildOpenAiHeaders(apiKey: string, settings?: Settings): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }
  for (const item of settings?.openaiHeaders ?? []) {
    const key = String(item?.key ?? '').trim()
    if (!key) continue
    if (item?.enabled === false) continue
    const lower = key.toLowerCase()
    if (RESERVED_OPENAI_HEADER_KEYS.has(lower)) continue
    headers[key] = String(item?.value ?? '')
  }
  return headers
}

function normalizeAiResult(obj: Record<string, unknown>): AiResult {
  const summary = String(obj.summary ?? '').trim() || 'AI 未返回摘要'
  return {
    summary,
    need_notify: Boolean(obj.need_notify ?? false),
    notify_title: obj.notify_title ? String(obj.notify_title) : undefined,
    notify_body: obj.notify_body ? String(obj.notify_body) : undefined,
    details: obj.details ? String(obj.details) : undefined
  }
}

/** 严格解析 AI 返回 JSON。只接受纯 JSON 或 fenced JSON。 */
export function parseAiJson(raw: string, expectedRunId?: string): AiResult {
  let s = raw.trim()
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenceMatch) s = fenceMatch[1].trim()

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(s)
  } catch (e) {
    throw new Error(
      `AI 返回 JSON 解析失败: ${(e as Error).message}\n原文前 500 字符:\n${s.slice(0, 500)}`
    )
  }

  if (expectedRunId) {
    const actualRunId = typeof obj.run_id === 'string' ? obj.run_id.trim() : ''
    if (!actualRunId) {
      throw new Error(`AI 返回缺少 run_id，期望值: ${expectedRunId}`)
    }
    if (actualRunId !== expectedRunId) {
      throw new Error(`AI 返回 run_id 不匹配: ${actualRunId} (期望 ${expectedRunId})`)
    }
  }
  return normalizeAiResult(obj)
}

const ANALYSIS_SYSTEM = `你是 Python 环境诊断助手。根据 ModuleNotFoundError 的日志和 Python 环境信息,给出一条安装缺失模块的命令。

必须以严格 JSON 输出，不要加 markdown 代码块，字段:
- package_name: string  pip 包名 (注意 import 名和包名可能不同,例如 cv2 → opencv-python, PIL → Pillow, yaml → PyYAML, sklearn → scikit-learn, bs4 → beautifulsoup4, skimage → scikit-image)
- install_argv: string[]  完整命令行 argv 数组 (不要拼成字符串)
- reasoning: string  一句话说明
- safe: boolean  包名合法且命令简单 → true;看起来可疑 → false

命令构造规则:
- conda 环境:  ["<pythonPath>", "-m", "pip", "install", "<pkg>"]
- uv 环境:    ["uv", "pip", "install", "--python", "<executable>", "<pkg>"]
- venv 环境:  ["<pythonPath>", "-m", "pip", "install", "<pkg>"]
- system 环境: ["<pythonPath>", "-m", "pip", "install", "--user", "<pkg>"]

不要加 --upgrade / --index-url / --pre / -e / git+ / 本地路径,除非错误日志里明确提示需要。`
export async function analyzeMissingModule(
  stderrTail: string,
  py: PythonInfo,
  cwd: string,
  opts: AnalyzeMissingOpts = {}
): Promise<InstallSuggestion> {
  const moduleName = (opts.missingModuleHint || parseModuleNotFound(stderrTail) || '').trim()
  if (moduleName) {
    const pkg = moduleToPackageName(moduleName)
    return {
      package_name: pkg,
      install_argv: buildDefaultInstallCmd(py, pkg),
      reasoning: `检测到缺包 ${moduleName}，按环境 ${py.envKind} 直接生成安装命令`,
      safe: true
    }
  }

  if (opts.disableAi) {
    const pkg = parseModuleNotFound(stderrTail)
    if (!pkg) throw new Error('未能从 stderr 中识别缺失模块')
    return {
      package_name: pkg,
      install_argv: buildDefaultInstallCmd(py, pkg),
      reasoning: `失败 AI 已关闭，按环境类型 ${py.envKind} 使用默认 pip 安装命令`,
      safe: true
    }
  }
  const user = `Python 环境:
  路径:        ${py.pythonPath}
  版本:        ${py.version ?? '(未知)'}
  类型:        ${py.envKind}
  详情:        ${py.envDetail ?? ''}
  executable:  ${py.executable ?? ''}
  prefix:      ${py.prefix ?? ''}

工作目录: ${cwd}

错误日志 (stderr 尾部):
${stderrTail.slice(-4000)}

请输出 JSON。`

  let raw: string
  try {
    raw =
      opts.provider === 'openai'
        ? await callOpenAiCompatible(opts.customSystemPrompt?.trim() || ANALYSIS_SYSTEM, user, {
            settings: opts.settings,
            purpose: 'analyze_missing_module'
          })
        : await callOpencodeSession(opts.customSystemPrompt?.trim() || ANALYSIS_SYSTEM, user, {
            settings: opts.settings,
            purpose: 'analyze_missing_module'
          })
  } catch (e) {
    const pkg = parseModuleNotFound(stderrTail)
    if (!pkg) throw e
    return {
      package_name: pkg,
      install_argv: buildDefaultInstallCmd(py, pkg),
      reasoning: `opencode 不可用,按环境类型 ${py.envKind} 使用默认 pip 安装命令`,
      safe: true
    }
  }

  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/, '')
    .trim()

  let parsed: InstallSuggestion
  try {
    parsed = JSON.parse(cleaned) as InstallSuggestion
  } catch (e) {
    // AI 返回不是合法 JSON,降级到默认命令
    const pkg = parseModuleNotFound(stderrTail)
    if (!pkg) throw new Error(`AI 返回内容非合法 JSON，且无法解析模块名: ${cleaned.slice(0, 200)}`)
    return {
      package_name: pkg,
      install_argv: buildDefaultInstallCmd(py, pkg),
      reasoning: `AI 返回解析失败,退化到默认命令: ${(e as Error).message}`,
      safe: true
    }
  }

  if (!parsed.package_name || !Array.isArray(parsed.install_argv) || parsed.install_argv.length < 3) {
    throw new Error(`AI 返回格式不符合要求（缺少 package_name / install_argv）: ${cleaned.slice(0, 300)}`)
  }

  if (typeof parsed.safe !== 'boolean') parsed.safe = true

  return parsed
}

const FAILURE_ANALYSIS_SYSTEM = `你是任务失败诊断助手。请根据失败信息给出可执行、可验证的结论。
规则：
1) 若是缺少包（ModuleNotFoundError），系统会先按 Python 环境自动安装并重试。你需要总结安装与重试结果。
2) 若不是缺包失败，请给出失败根因和脚本修改建议（明确修改方向/示例思路）。
必须输出 JSON 字段：
- summary: string（必填，失败原因一句话）
- details: string（必填，Markdown 格式，固定三段：
  ## 根因判断
  ## 修改建议
  ## 验证步骤
  缺包场景的“修改建议”写为安装/重试结果与后续动作；非缺包场景给脚本修改点）
- need_notify: boolean（必填，只有确实需要提醒用户时才为 true）
- notify_title: string（可选）
- notify_body: string（可选）`

export async function analyzeFailureReason(input: FailureAiInput): Promise<AiResult> {
  const user = `任务名: ${input.taskName}
失败类型: ${input.failReason}
退出码: ${input.exitCode ?? '(none)'}

stdout 尾部:
${input.stdoutTail.slice(-3000)}

stderr 尾部:
${input.stderrTail.slice(-4000)}

请输出 JSON，字段包含 summary, details, need_notify, notify_title, notify_body。need_notify 只有确实需要提醒用户时才为 true。${input.runId ? `另外必须包含字段 run_id，且值必须严格等于 "${input.runId}"。` : ''}`
  try {
    const raw =
      input.provider === 'openai'
        ? await callOpenAiCompatible(input.customPrompt?.trim() || FAILURE_ANALYSIS_SYSTEM, user, {
            settings: input.settings,
            runId: input.runId,
            purpose: 'analyze_failure'
          })
        : await callOpencodeSession(input.customPrompt?.trim() || FAILURE_ANALYSIS_SYSTEM, user, {
            settings: input.settings,
            runId: input.runId,
            purpose: 'analyze_failure'
          })
    return parseAiJson(raw, input.runId)
  } catch (e) {
    return {
      summary: `失败原因待确认：${input.failReason}`,
      details: (e as Error).message,
      need_notify: false
    }
  }
}
