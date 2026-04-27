import { dialog, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { paths } from './paths'
import type { UploadedScript } from '@shared/types'

const ALLOWED_EXT = new Set(['.py', '.bat', '.cmd', '.ps1'])

function hasAllowedExt(name: string): boolean {
  return ALLOWED_EXT.has(path.extname(name).toLowerCase())
}

/** 列出 tasks/ 下所有支持脚本（含子目录，跳过隐藏文件和 __pycache__） */
export function listScripts(): string[] {
  const root = paths().tasksDir
  const walk = (d: string, prefix: string): string[] => {
    const out: string[] = []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '__pycache__' || e.name === 'node_modules') continue
      if (e.isDirectory()) {
        out.push(...walk(path.join(d, e.name), prefix + e.name + '/'))
      } else if (e.isFile() && hasAllowedExt(e.name)) {
        out.push(prefix + e.name)
      }
    }
    return out
  }
  return walk(root, '').sort()
}

/** 清洗文件名：只留字母数字下划线横杠点，杜绝路径穿越 */
function sanitizeName(name: string): string {
  const base = path.basename(name)
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_')
  if (!cleaned || /^\.+$/.test(cleaned)) return 'script.py'
  if (hasAllowedExt(cleaned)) return cleaned
  return cleaned + '.py'
}

/** 同名冲突时自动加后缀：name.py → name_1.py → name_2.py */
function uniquify(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name
  const ext = path.extname(name)
  const stem = name.slice(0, -ext.length)
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem}_${i}${ext}`
    if (!fs.existsSync(path.join(dir, candidate))) return candidate
  }
  throw new Error('无法生成唯一文件名，请清理重复文件后重试')
}

/**
 * 上传脚本到 tasks/。若未传 sourcePath 则弹出系统文件选择框。
 * 返回 null 表示用户取消。
 */
export async function uploadScript(
  opts: { sourcePath?: string; overwrite?: boolean; parentWindow?: BrowserWindow | null } = {}
): Promise<UploadedScript | null> {
  let src = opts.sourcePath

  if (!src) {
    const parent = opts.parentWindow ?? BrowserWindow.getFocusedWindow() ?? undefined
    const r = parent
      ? await dialog.showOpenDialog(parent, {
          title: '选择脚本文件',
          filters: [
            { name: '支持脚本', extensions: ['py', 'bat', 'cmd', 'ps1'] },
            { name: 'Python 脚本', extensions: ['py'] },
            { name: '批处理脚本', extensions: ['bat', 'cmd'] },
            { name: 'PowerShell 脚本', extensions: ['ps1'] }
          ],
          properties: ['openFile']
        })
      : await dialog.showOpenDialog({
          title: '选择脚本文件',
          filters: [
            { name: '支持脚本', extensions: ['py', 'bat', 'cmd', 'ps1'] },
            { name: 'Python 脚本', extensions: ['py'] },
            { name: '批处理脚本', extensions: ['bat', 'cmd'] },
            { name: 'PowerShell 脚本', extensions: ['ps1'] }
          ],
          properties: ['openFile']
        })
    if (r.canceled || r.filePaths.length === 0) return null
    src = r.filePaths[0]
  }

  if (!hasAllowedExt(src)) {
    throw new Error('仅支持 .py / .bat / .cmd / .ps1 文件类型')
  }
  if (!fs.existsSync(src)) {
    throw new Error(`源文件不存在: ${src}`)
  }
  const stat0 = fs.statSync(src)
  if (!stat0.isFile()) {
    throw new Error('所选路径不是文件')
  }
  const MAX_SIZE = 5 * 1024 * 1024
  if (stat0.size > MAX_SIZE) {
    throw new Error(`文件过大（> 5 MB）: ${stat0.size} 字节`)
  }

  const tasksDir = paths().tasksDir
  const desiredName = sanitizeName(src)

  let targetName: string
  let overwritten = false
  if (fs.existsSync(path.join(tasksDir, desiredName))) {
    if (opts.overwrite) {
      targetName = desiredName
      overwritten = true
    } else {
      targetName = uniquify(tasksDir, desiredName)
    }
  } else {
    targetName = desiredName
  }

  const targetPath = path.join(tasksDir, targetName)

  // 二次防御：最终路径必须在 tasksDir 内
  const resolvedTarget = path.resolve(targetPath)
  const resolvedRoot = path.resolve(tasksDir)
  if (
    !resolvedTarget.startsWith(resolvedRoot + path.sep) &&
    resolvedTarget !== resolvedRoot
  ) {
    throw new Error('目标路径非法')
  }

  fs.copyFileSync(src, targetPath)
  const stat = fs.statSync(targetPath)

  return {
    fileName: targetName,
    absolutePath: targetPath,
    size: stat.size,
    overwritten
  }
}
