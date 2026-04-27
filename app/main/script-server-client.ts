import fs from 'node:fs'
import path from 'node:path'
import { paths } from './paths'
import { runtimeLog } from './logger'
import type { RemoteScriptItem, Settings, UploadedScript } from '@shared/types'

const ALLOWED_EXT = new Set(['.py', '.bat', '.cmd', '.ps1'])
const MAX_UPLOAD_SIZE = 5 * 1024 * 1024

function ensureServerEnabled(settings: Settings): string {
  if (!settings.scriptServerEnabled) {
    throw new Error('脚本服务器未启用，请先在设置页开启。')
  }
  const baseUrl = String(settings.scriptServerBaseUrl ?? '').trim()
  if (!baseUrl) {
    throw new Error('脚本服务器地址未配置，请先在设置页填写。')
  }
  return baseUrl.replace(/\/+$/, '')
}

function assertAllowedFileName(fileName: string): string {
  const name = String(fileName ?? '').trim()
  if (!name) throw new Error('脚本名称不能为空。')
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('脚本名称不合法。')
  }
  const ext = path.extname(name).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`仅支持以下脚本类型: ${Array.from(ALLOWED_EXT).join(', ')}`)
  }
  return name
}

function safeTargetPath(fileName: string, overwrite: boolean): { fileName: string; absPath: string; overwritten: boolean } {
  const root = paths().tasksDir
  const cleanName = assertAllowedFileName(fileName)
  let targetName = cleanName
  let overwritten = false
  let abs = path.join(root, targetName)
  if (fs.existsSync(abs)) {
    if (overwrite) {
      overwritten = true
    } else {
      const ext = path.extname(cleanName)
      const stem = cleanName.slice(0, -ext.length)
      let idx = 1
      while (true) {
        targetName = `${stem}_${idx}${ext}`
        abs = path.join(root, targetName)
        if (!fs.existsSync(abs)) break
        idx++
      }
    }
  }
  const resolvedRoot = path.resolve(root)
  const resolvedAbs = path.resolve(abs)
  if (!resolvedAbs.startsWith(resolvedRoot + path.sep) && resolvedAbs !== resolvedRoot) {
    throw new Error('目标路径非法。')
  }
  return { fileName: targetName, absPath: resolvedAbs, overwritten }
}

export async function listRemoteScripts(settings: Settings): Promise<RemoteScriptItem[]> {
  const baseUrl = ensureServerEnabled(settings)
  const url = `${baseUrl}/api/scripts`
  runtimeLog.info('script_server_list_start', { url })
  const resp = await fetch(url)
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`脚本服务器请求失败（HTTP ${resp.status}）: ${body.slice(0, 300)}`)
  }
  const json = (await resp.json()) as { items?: unknown[] }
  if (!Array.isArray(json.items)) return []
  const items = json.items
    .map((x) => {
      const r = x as Record<string, unknown>
      const fileName = String(r.fileName ?? '').trim()
      const summary = String(r.summary ?? '').trim()
      const size = Number(r.size ?? 0)
      const updatedAt = String(r.updatedAt ?? '')
      if (!fileName) return null
      if (!ALLOWED_EXT.has(path.extname(fileName).toLowerCase())) return null
      return {
        fileName,
        summary: summary || '暂无简介',
        size: Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0,
        updatedAt
      } as RemoteScriptItem
    })
    .filter((x): x is RemoteScriptItem => x !== null)
  runtimeLog.info('script_server_list_done', { count: items.length })
  return items
}

export async function downloadRemoteScript(
  settings: Settings,
  input: { fileName: string; overwrite?: boolean }
): Promise<UploadedScript> {
  const baseUrl = ensureServerEnabled(settings)
  const requested = assertAllowedFileName(input.fileName)
  const url = `${baseUrl}/api/scripts/download?fileName=${encodeURIComponent(requested)}`
  runtimeLog.info('script_server_download_start', { url, fileName: requested })
  const resp = await fetch(url)
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`脚本下载失败（HTTP ${resp.status}）: ${body.slice(0, 300)}`)
  }
  const ab = await resp.arrayBuffer()
  const buf = Buffer.from(ab)
  const { fileName, absPath, overwritten } = safeTargetPath(requested, input.overwrite === true)
  fs.writeFileSync(absPath, buf)
  runtimeLog.info('script_server_download_done', { fileName, size: buf.length, overwritten })
  return { fileName, absolutePath: absPath, size: buf.length, overwritten }
}

export async function uploadScriptToRemote(
  settings: Settings,
  input: { scriptPath: string; overwrite?: boolean }
): Promise<{ uploaded: boolean; fileName: string; summary?: string }> {
  const baseUrl = ensureServerEnabled(settings)
  const scriptPath = String(input.scriptPath ?? '').trim()
  if (!scriptPath) throw new Error('请先选择本地脚本。')
  const root = paths().tasksDir
  const abs = path.resolve(root, scriptPath)
  if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) {
    throw new Error('脚本路径非法。')
  }
  if (!fs.existsSync(abs)) throw new Error(`本地脚本不存在: ${scriptPath}`)
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw new Error('目标脚本不是文件。')
  if (stat.size > MAX_UPLOAD_SIZE) {
    throw new Error(`脚本文件过大（>${MAX_UPLOAD_SIZE} 字节）。`)
  }
  const fileName = assertAllowedFileName(path.basename(scriptPath))
  const data = fs.readFileSync(abs)
  const url = `${baseUrl}/api/scripts/upload`
  runtimeLog.info('script_server_upload_start', { fileName, size: data.length, overwrite: input.overwrite === true })
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName,
      overwrite: input.overwrite === true,
      contentBase64: data.toString('base64')
    })
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`脚本上传失败（HTTP ${resp.status}）: ${body.slice(0, 300)}`)
  }
  const json = (await resp.json().catch(() => ({}))) as { summary?: unknown }
  const summary = typeof json.summary === 'string' ? json.summary.trim() : ''
  runtimeLog.info('script_server_upload_done', { fileName })
  return { uploaded: true, fileName, summary: summary || undefined }
}
