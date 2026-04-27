import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PythonInfo, PythonEnvKind } from '@shared/types'

const execFileAsync = promisify(execFile)

const PROBE_SCRIPT = `
import sys, os, json
info = {
  "version": sys.version.split()[0],
  "executable": sys.executable,
  "prefix": sys.prefix,
  "base_prefix": getattr(sys, "base_prefix", sys.prefix),
  "conda_prefix": os.environ.get("CONDA_PREFIX"),
  "conda_default_env": os.environ.get("CONDA_DEFAULT_ENV"),
  "virtual_env": os.environ.get("VIRTUAL_ENV"),
  "pyvenv_cfg": None,
  "pip_ok": False,
}
cfg = os.path.join(sys.prefix, "pyvenv.cfg")
if os.path.exists(cfg):
    try:
        with open(cfg, "r", encoding="utf-8", errors="ignore") as f:
            info["pyvenv_cfg"] = f.read()
    except Exception:
        pass
try:
    import pip  # noqa: F401
    info["pip_ok"] = True
except Exception:
    pass
print(json.dumps(info))
`

const cache = new Map<string, { info: PythonInfo; at: number }>()
const TTL_MS = 60_000

export function invalidatePythonCache(key?: string): void {
  if (key) cache.delete(key)
  else cache.clear()
}

export async function checkPython(pythonPath: string, useCache = true): Promise<PythonInfo> {
  const key = (pythonPath || 'python').trim()
  if (useCache) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.info
  }
  const info = await doCheck(key)
  cache.set(key, { info, at: Date.now() })
  return info
}

async function doCheck(pythonPath: string): Promise<PythonInfo> {
  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', PROBE_SCRIPT], {
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    })
    const data = JSON.parse(stdout.trim()) as Record<string, unknown>
    const envKind = detectEnvKind(data)
    return {
      ok: true,
      pythonPath,
      version: `Python ${data.version}`,
      envKind,
      envDetail: describeEnv(envKind, data),
      executable: String(data.executable ?? ''),
      prefix: String(data.prefix ?? ''),
      basePrefix: String(data.base_prefix ?? ''),
      pipAvailable: !!data.pip_ok,
      detectedAt: new Date().toISOString()
    }
  } catch (e) {
    return classifyError(pythonPath, e)
  }
}

function detectEnvKind(data: Record<string, unknown>): PythonEnvKind {
  const cfg = typeof data.pyvenv_cfg === 'string' ? data.pyvenv_cfg : ''
  if (/^\s*uv\s*=/im.test(cfg)) return 'uv'
  const prefix = String(data.prefix ?? '').toLowerCase()
  if (data.conda_prefix || /conda|miniconda|anaconda/.test(prefix)) return 'conda'
  if (data.virtual_env || data.prefix !== data.base_prefix) return 'venv'
  return 'system'
}

function describeEnv(kind: PythonEnvKind, d: Record<string, unknown>): string {
  switch (kind) {
    case 'conda':
      return `conda · env=${d.conda_default_env ?? '(unnamed)'} @ ${d.conda_prefix ?? d.prefix}`
    case 'uv':
      return `uv venv @ ${d.prefix}`
    case 'venv':
      return `venv @ ${d.prefix}`
    case 'system':
      return `system @ ${d.prefix}`
    default:
      return ''
  }
}

function classifyError(pythonPath: string, e: unknown): PythonInfo {
  const err = e as NodeJS.ErrnoException & { code?: number | string; stderr?: string }
  const msg = err.stderr || err.message || String(e)
  const code = typeof err.code === 'number' ? String(err.code) : err.code
  const isNotFound =
    code === 'ENOENT' ||
    code === '9009' ||
    /ENOENT/.test(msg) ||
    /is not recognized/i.test(msg) ||
    /command not found/i.test(msg)

  let errorType: PythonInfo['errorType'] = 'exec_failed'
  let friendly = msg
  if (isNotFound) {
    errorType = 'not_found'
    friendly =
      `系统里找不到 "${pythonPath}" 可执行文件 (Windows 错误码 9009 / ENOENT)。\n` +
      `排查:\n` +
      `  1. 命令行里跑一下 "${pythonPath} --version"，能跑通吗？\n` +
      `  2. Windows: 装 Python 时勾 "Add to PATH"，或者把设置改成 "py" / 绝对路径\n` +
      `  3. Windows 11 注意关掉“应用执行别名”里的 python / python3 占位符 (否则会跳转商店)\n` +
      `  4. 命令行 "where python" 或 "where py" 看实际在哪`
  } else if (/Permission denied|EACCES/i.test(msg)) {
    errorType = 'permission'
    friendly = `无权限执行 "${pythonPath}": ${msg}`
  }

  return {
    ok: false,
    pythonPath,
    envKind: 'unknown',
    error: friendly,
    errorType,
    detectedAt: new Date().toISOString()
  }
}

export function parseModuleNotFound(stderr: string): string | null {
  if (!stderr) return null
  const m = stderr.match(/ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/)
  if (!m) return null
  return m[1].split('.')[0]
}

export function buildDefaultInstallCmd(info: PythonInfo, pkg: string): string[] {
  if (info.envKind === 'uv') {
    return ['uv', 'pip', 'install', '--python', info.executable || info.pythonPath, pkg]
  }
  const argv = [info.pythonPath, '-m', 'pip', 'install', pkg]
  if (info.envKind === 'system') argv.splice(4, 0, '--user')
  return argv
}

export function buildBatchInstallCmd(info: PythonInfo, pkgs: string[]): string[] {
  const uniq = Array.from(new Set(pkgs.filter(Boolean)))
  if (uniq.length === 0) return buildDefaultInstallCmd(info, '')
  if (info.envKind === 'uv') {
    return ['uv', 'pip', 'install', '--python', info.executable || info.pythonPath, ...uniq]
  }
  const argv = [info.pythonPath, '-m', 'pip', 'install']
  if (info.envKind === 'system') argv.push('--user')
  argv.push(...uniq)
  return argv
}

export function moduleToPackageName(moduleName: string): string {
  const m = moduleName.trim().toLowerCase()
  const map: Record<string, string> = {
    cv2: 'opencv-python',
    pil: 'Pillow',
    yaml: 'PyYAML',
    sklearn: 'scikit-learn',
    bs4: 'beautifulsoup4',
    skimage: 'scikit-image'
  }
  return map[m] ?? moduleName
}

const PRECHECK_SCRIPT = `
import ast, json, sys
import importlib.util
import sysconfig
from pathlib import Path

script = Path(sys.argv[1])
code = script.read_text(encoding="utf-8", errors="ignore")
tree = ast.parse(code, filename=str(script))

mods = set()
for n in ast.walk(tree):
    if isinstance(n, ast.Import):
        for a in n.names:
            mods.add(a.name.split(".")[0])
    elif isinstance(n, ast.ImportFrom):
        if n.module:
            mods.add(n.module.split(".")[0])

mods = {m for m in mods if m and not m.startswith("_")}

stdlib = set(getattr(sys, "stdlib_module_names", set()))
try:
    stdlib_path = sysconfig.get_paths().get("stdlib", "")
except Exception:
    stdlib_path = ""

def is_stdlib(name: str) -> bool:
    if name in stdlib:
        return True
    try:
        spec = importlib.util.find_spec(name)
    except Exception:
        return False
    if spec is None or not getattr(spec, "origin", None):
        return False
    origin = str(spec.origin)
    if "site-packages" in origin or "dist-packages" in origin:
        return False
    if stdlib_path and origin.startswith(stdlib_path):
        return True
    return False

missing = []
for m in sorted(mods):
    if is_stdlib(m):
        continue
    try:
        spec = importlib.util.find_spec(m)
        if spec is None:
            missing.append(m)
    except Exception:
        missing.append(m)

print(json.dumps({"imports": sorted(mods), "missing": missing}, ensure_ascii=False))
`

export async function detectMissingModulesForScript(
  pythonPath: string,
  scriptPath: string
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', PRECHECK_SCRIPT, scriptPath], {
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    })
    const data = JSON.parse(stdout.trim()) as { missing?: string[] }
    return Array.isArray(data.missing) ? data.missing.filter(Boolean) : []
  } catch {
    return []
  }
}

export function isInstallArgvSafe(argv: string[], allowedExec: string[]): boolean {
  if (!Array.isArray(argv) || argv.length < 3 || argv.length > 120) return false

  for (const a of argv) {
    if (typeof a !== 'string') return false
    if (/[;&|`$<>()\n\r]/.test(a)) return false
    if (a.includes('&&') || a.includes('||')) return false
  }

  const exec = argv[0]
  const execOk = allowedExec.some((e) => {
    if (!e) return false
    return exec === e || exec.endsWith('\\' + e) || exec.endsWith('/' + e)
  })
  if (!execOk) return false

  const joined = argv.join(' ')
  if (!/\bpip\s+install\b/.test(joined)) return false

  if (argv.some((a) => a === '-e' || a === '--editable')) return false
  if (argv.slice(1).some((a) => /^(git\+|svn\+|hg\+|bzr\+|file:)/i.test(a))) return false

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (/^(\.\/|\.\\)/.test(a)) return false
    if (/^[A-Za-z]:\\/.test(a) && (a.endsWith('.whl') || a.endsWith('.tar.gz') || a.endsWith('.zip'))) {
      return false
    }
    if (a.startsWith('/') && (a.endsWith('.whl') || a.endsWith('.tar.gz') || a.endsWith('.zip'))) {
      return false
    }
  }

  return true
}
