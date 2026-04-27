import fs from 'node:fs'
import path from 'node:path'
import type { ArgDef, ArgSchemaGenerateResult, OpenAiHeaderItem, Settings } from '@shared/types'
import { paths } from './paths'

const MAX_SCRIPT_BYTES = 1024 * 1024

function hasOpenAiConfig(settings: Settings): boolean {
  return !!(
    String(settings.openaiBaseUrl ?? '').trim() &&
    String(settings.openaiApiKey ?? '').trim() &&
    String(settings.openaiModel ?? '').trim()
  )
}

function safeAbsScriptPath(scriptPath: string): string {
  const rel = String(scriptPath ?? '').trim()
  if (!rel) throw new Error('脚本路径不能为空。')
  const root = path.resolve(paths().tasksDir)
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error('脚本路径非法。')
  }
  return abs
}

function guessTypeByHint(line: string): ArgDef['type'] {
  const s = line.toLowerCase()
  if (s.includes('type=int') || s.includes('type = int')) return 'number'
  if (s.includes('type=float') || s.includes('type = float')) return 'number'
  if (s.includes('store_true') || s.includes('bool')) return 'boolean'
  if (s.includes('choices=')) return 'enum'
  return 'string'
}

function parseChoices(line: string): string[] | undefined {
  const m = line.match(/choices\s*=\s*\[([^\]]+)\]/i)
  if (!m) return undefined
  return m[1]
    .split(',')
    .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

function parseDefault(line: string): unknown {
  const m = line.match(/default\s*=\s*([^,\)]+)/i)
  if (!m) return undefined
  const raw = m[1].trim().replace(/^['"]|['"]$/g, '')
  if (raw === 'True') return true
  if (raw === 'False') return false
  const n = Number(raw)
  return Number.isFinite(n) && raw !== '' ? n : raw
}

function parseDescription(line: string): string | undefined {
  const m = line.match(/help\s*=\s*["']([^"']+)["']/i)
  return m?.[1]?.trim() || undefined
}

function upsertArg(schema: Record<string, ArgDef>, key: string, def: ArgDef): void {
  if (!key) return
  if (!schema[key]) {
    schema[key] = def
    return
  }
  schema[key] = {
    ...schema[key],
    ...def,
    description: schema[key].description || def.description
  }
}

function parseWithRegex(content: string): Record<string, ArgDef> {
  const lines = content.split(/\r?\n/)
  const schema: Record<string, ArgDef> = {}

  for (const line of lines) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue

    const argparse = s.match(/add_argument\s*\((.+)\)/i)
    if (argparse) {
      const flags = [...s.matchAll(/["']--([a-zA-Z0-9][\w-]*)["']/g)].map((m) => m[1])
      const key = (flags[0] ?? '').replace(/-/g, '_')
      if (key) {
        upsertArg(schema, key, {
          type: guessTypeByHint(s),
          required: /required\s*=\s*true/i.test(s),
          description: parseDescription(s),
          default: parseDefault(s),
          enumValues: parseChoices(s)
        })
      }
      continue
    }

    const click = s.match(/@(click\.)?option\s*\((.+)\)/i)
    if (click) {
      const flags = [...s.matchAll(/["']--([a-zA-Z0-9][\w-]*)["']/g)].map((m) => m[1])
      const key = (flags[0] ?? '').replace(/-/g, '_')
      if (key) {
        upsertArg(schema, key, {
          type: guessTypeByHint(s),
          required: /required\s*=\s*true/i.test(s),
          description: parseDescription(s),
          default: parseDefault(s),
          enumValues: parseChoices(s)
        })
      }
      continue
    }
  }

  // 通用 flag 兜底：提取 --name 风格参数
  for (const m of content.matchAll(/(^|\s)--([a-zA-Z0-9][\w-]*)/g)) {
    const key = m[2].replace(/-/g, '_')
    if (!schema[key]) schema[key] = { type: 'string' }
  }

  return schema
}

function normalizeArgDef(input: unknown): ArgDef | null {
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>
  const t = rec.type
  const type: ArgDef['type'] =
    t === 'number' || t === 'boolean' || t === 'enum' || t === 'string' ? t : 'string'
  const out: ArgDef = { type }
  if (typeof rec.required === 'boolean') out.required = rec.required
  if (typeof rec.description === 'string' && rec.description.trim()) out.description = rec.description.trim()
  if (Array.isArray(rec.enumValues)) {
    const values = rec.enumValues.map((x) => String(x).trim()).filter(Boolean)
    if (values.length > 0) out.enumValues = values
  }
  if (rec.default !== undefined) out.default = rec.default
  return out
}

function buildOpenAiHeaders(settings: Settings): Record<string, string> {
  const apiKey = String(settings.openaiApiKey ?? '').trim()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  }
  const extras = Array.isArray(settings.openaiHeaders) ? settings.openaiHeaders : []
  const reserved = new Set(['authorization', 'content-type'])
  for (const h of extras as OpenAiHeaderItem[]) {
    if (!h || h.enabled === false) continue
    const key = String(h.key ?? '').trim()
    const value = String(h.value ?? '')
    if (!key || reserved.has(key.toLowerCase())) continue
    headers[key] = value
  }
  return headers
}

async function generateByAi(content: string, settings: Settings): Promise<Record<string, ArgDef>> {
  const endpoint = `${String(settings.openaiBaseUrl).replace(/\/+$/, '')}/chat/completions`
  const timeoutSec = Math.max(5, Number(settings.openaiTimeoutSec ?? 20))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000)
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: buildOpenAiHeaders(settings),
      body: JSON.stringify({
        model: settings.openaiModel,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '你是脚本参数标准化助手。请从脚本中提取可配置参数，输出 JSON 对象，键为参数名，值为 {type, required, default, description, enumValues}。type 只能是 string/number/boolean/enum。无法确定时用 string。'
          },
          {
            role: 'user',
            content: `请为以下脚本生成参数定义：\n\n${content.slice(0, 8000)}`
          }
        ]
      }),
      signal: controller.signal
    })
    if (!resp.ok) return {}
    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
    }
    const raw = json.choices?.[0]?.message?.content
    const text =
      typeof raw === 'string'
        ? raw.trim()
        : Array.isArray(raw)
          ? raw.map((x) => x?.text ?? '').join('\n').trim()
          : ''
    if (!text) return {}
    const parsed = JSON.parse(text) as Record<string, unknown>
    const out: Record<string, ArgDef> = {}
    for (const [k, v] of Object.entries(parsed ?? {})) {
      const key = String(k).trim().replace(/-/g, '_')
      if (!key) continue
      const def = normalizeArgDef(v)
      if (def) out[key] = def
    }
    return out
  } catch {
    return {}
  } finally {
    clearTimeout(timeout)
  }
}

export async function generateArgSchemaForScript(
  scriptPath: string,
  settings: Settings
): Promise<ArgSchemaGenerateResult> {
  const abs = safeAbsScriptPath(scriptPath)
  if (!fs.existsSync(abs)) {
    throw new Error(`脚本不存在：${scriptPath}`)
  }
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw new Error('目标路径不是文件。')
  if (stat.size > MAX_SCRIPT_BYTES) {
    throw new Error('脚本文件过大，暂不支持自动生成参数。')
  }
  const content = fs.readFileSync(abs, 'utf8')
  const parsed = parseWithRegex(content)
  if (Object.keys(parsed).length > 0) {
    return {
      argsSchema: parsed,
      source: 'parser',
      standardized: true,
      needsDeveloperInput: false,
      message: '已通过脚本解析自动生成参数。'
    }
  }

  if (!hasOpenAiConfig(settings)) {
    return {
      argsSchema: {},
      source: 'none',
      standardized: false,
      needsDeveloperInput: true,
      message: '未检测到标准参数，且未配置 AI。请开发者补全参数定义或配置 AI。'
    }
  }

  const aiSchema = await generateByAi(content, settings)
  if (Object.keys(aiSchema).length === 0) {
    return {
      argsSchema: {},
      source: 'none',
      standardized: false,
      needsDeveloperInput: true,
      message: 'AI 未能生成参数定义，请开发者补全。'
    }
  }
  return {
    argsSchema: aiSchema,
    source: 'ai',
    standardized: true,
    needsDeveloperInput: false,
    message: '已通过 AI 自动生成参数。'
  }
}
