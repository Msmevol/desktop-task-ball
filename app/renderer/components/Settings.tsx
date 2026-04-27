import { useEffect, useState } from 'react'
import { api, unwrap } from '../api'
import { useStore } from '../store'
import type { Settings, OpencodeStatus, MainEvent, PythonInfo, OpenAiHeaderItem } from '@shared/types'

export function SettingsView() {
  const { setToast, txt, lang, setLang, theme, setTheme, setTab, editTask } = useStore()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)
  const [testingOpenAi, setTestingOpenAi] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [health, setHealth] = useState<{
    pythonOk: boolean
    opencodeReady: boolean
    opencodeState: string
    tasksTotal: number
    missingScripts: number
  } | null>(null)

  useEffect(() => {
    api.settings.get().then((r) => r.ok && setSettings(r.data))
  }, [])

  if (!settings) return <div className="p-6 text-ink-dim">{txt('配置加载中...', 'Loading settings...')}</div>
  const pythonReady = !!settings.pythonPath?.trim()
  const openAiReady = !!(settings.openaiBaseUrl && settings.openaiApiKey && settings.openaiModel)

  const runHealthCheck = async () => {
    try {
      const h = await unwrap(api.app.healthCheck())
      setHealth({
        pythonOk: h.pythonOk,
        opencodeReady: h.opencodeReady,
        opencodeState: h.opencodeState,
        tasksTotal: h.tasksTotal,
        missingScripts: h.missingScripts
      })
      setToast(txt('健康检查完成', 'Health check complete'))
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  const save = async () => {
    const dupHeader = findDupHeader(settings.openaiHeaders ?? [])
    if (dupHeader) {
      setToast(txt(`Header 重复: ${dupHeader}`, `Duplicate header: ${dupHeader}`))
      return
    }
    setBusy(true)
    try {
      const next = await unwrap(api.settings.set(settings))
      setSettings(next)
      setToast(txt('设置已保存', 'Settings saved'))
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const testOpenAi = async () => {
    setTestingOpenAi(true)
    try {
      const r = await unwrap(api.settings.testOpenAI(settings))
      if (r.ok) {
        setToast(
          txt(
            `OpenAI 连接成功（模型: ${r.model ?? 'unknown'}，耗时: ${r.latencyMs}ms）`,
            `OpenAI connection successful (model: ${r.model ?? 'unknown'}, latency: ${r.latencyMs}ms)`
          )
        )
      } else {
        setToast(
          txt(
            `OpenAI 连接失败 [${r.status}] ${r.message}`,
            `OpenAI connection failed [${r.status}] ${r.message}`
          )
        )
      }
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setTestingOpenAi(false)
    }
  }

  return (
    <div className="page-shell max-w-4xl">
      <div className="page-header">
        <div>
          <h2 className="text-lg font-bold">{txt('设置', 'Settings')}</h2>
          <div className="text-xs text-ink-faint mt-0.5">{txt('运行环境、导入导出与健康检查。AI 在高级设置中配置。', 'Runtime, import/export and health checks. AI is configured in Advanced settings.')}</div>
        </div>
      </div>

      <div className="panel-card p-3 flex flex-wrap gap-2 items-center">
        <div className="text-sm text-ink-dim mr-2">{txt('界面偏好', 'UI Preferences')}</div>
        <button className="theme-chip" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
          {lang === 'zh' ? '中文' : 'EN'}
        </button>
        <button className="theme-chip" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? txt('深色', 'Dark') : txt('浅色', 'Light')}
        </button>
      </div>

      <div className="panel-card p-3 space-y-2">
        <div className="section-title">{txt('最小必配状态', 'Minimal Required Status')}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          <div className={'card p-2 ' + (pythonReady ? 'border-accent/40' : 'border-warn/40')}>
            {txt('Python 路径', 'Python path')}: {pythonReady ? txt('已配置', 'Configured') : txt('未配置', 'Missing')}
          </div>
          <div className={'card p-2 ' + (openAiReady ? 'border-accent/40' : 'border-line')}>
            {txt('OpenAI（可选）', 'OpenAI (optional)')}: {openAiReady ? txt('已配置', 'Configured') : txt('未配置', 'Not set')}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-primary" onClick={() => { setTab('tasks'); editTask('new') }}>
            {txt('创建第一个任务', 'Create First Task')}
          </button>
          <button className="btn" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? txt('收起高级设置', 'Hide Advanced') : txt('展开高级设置', 'Show Advanced')}
          </button>
        </div>
      </div>

      <PythonPathField
        value={settings.pythonPath}
        onChange={(v) => setSettings({ ...settings, pythonPath: v })}
        onToast={setToast}
      />

      {showAdvanced && <OpencodeSection onToast={setToast} />}

      {showAdvanced && (
        <>
      <Field
        label={txt('opencode 可执行文件路径', 'opencode Binary Path')}
        hint={txt(
          '留空表示使用 PATH 中的 opencode。也可填写绝对路径，例如 D:\\tools\\opencode.cmd 或 /usr/local/bin/opencode。修改后请先保存，再在上方执行重启。',
          'Leave empty to use opencode from PATH. You can also set an absolute path.'
        )}
      >
        <input
          className="input font-mono"
          value={settings.opencodeBinPath}
          onChange={(e) => setSettings({ ...settings, opencodeBinPath: e.target.value })}
          placeholder="opencode"
        />
      </Field>

      <Field
        label={txt('opencode 端口', 'opencode Port')}
        hint={txt('默认 4097。若端口被残留 opencode 占用，重启时会自动清理并拉起。', 'Default 4097. Residual opencode on same port will be cleaned on restart.')}
      >
        <input
          className="input font-mono"
          type="number"
          min={1}
          max={65535}
          value={settings.opencodePort ?? 4097}
          onChange={(e) => setSettings({ ...settings, opencodePort: Number(e.target.value) || 4097 })}
          placeholder="4097"
        />
      </Field>
        </>
      )}

      {showAdvanced ? (
        <>
          <Field
            label={txt('高级：OpenAI 兼容 Base URL', 'Advanced: OpenAI Compatible Base URL')}
            hint={txt('例如 https://api.openai.com 或你的兼容网关地址（不带 /v1）', 'Example: https://api.openai.com (without /v1)')}
          >
            <input
              className="input font-mono"
              value={settings.openaiBaseUrl ?? ''}
              onChange={(e) => setSettings({ ...settings, openaiBaseUrl: e.target.value })}
              placeholder="https://api.openai.com"
            />
          </Field>
          <Field label={txt('高级：OpenAI 兼容 API Key', 'Advanced: OpenAI Compatible API Key')}>
            <input
              className="input font-mono"
              type="password"
              value={settings.openaiApiKey ?? ''}
              onChange={(e) => setSettings({ ...settings, openaiApiKey: e.target.value })}
              placeholder="sk-..."
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={txt('高级：OpenAI 模型名', 'Advanced: OpenAI Model')}>
              <input
                className="input font-mono"
                value={settings.openaiModel ?? ''}
                onChange={(e) => setSettings({ ...settings, openaiModel: e.target.value })}
                placeholder="gpt-4o-mini"
              />
            </Field>
            <Field label={txt('高级：OpenAI 超时（秒）', 'Advanced: OpenAI Timeout (sec)')}>
              <input
                className="input font-mono"
                type="number"
                min={1}
                max={600}
                value={settings.openaiTimeoutSec ?? 60}
                onChange={(e) => setSettings({ ...settings, openaiTimeoutSec: Number(e.target.value) || 60 })}
              />
            </Field>
          </div>
          <OpenAiHeadersEditor
            value={settings.openaiHeaders ?? []}
            txt={txt}
            onChange={(v) => setSettings({ ...settings, openaiHeaders: v })}
          />
          <div className="flex justify-end">
            <button className="btn" type="button" onClick={testOpenAi} disabled={testingOpenAi}>
              {testingOpenAi ? txt('测试中...', 'Testing...') : txt('测试 OpenAI 连接', 'Test OpenAI Connection')}
            </button>
          </div>
        </>
      ) : (
        <div className="text-xs text-ink-faint">
          {txt('AI 分析相关配置已收纳到“高级设置”。', 'AI analysis configuration is available in Advanced settings.')}
        </div>
      )}

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={settings.autoInstallEnabled !== false}
          onChange={(e) => setSettings({ ...settings, autoInstallEnabled: e.target.checked })}
          className="accent-accent"
        />
        <span className="text-sm">
          {txt('自动安装缺失的 Python 模块', 'Auto-install Missing Python Modules')}
          <span className="text-ink-faint ml-1">
            {txt(
              '(脚本出现 ModuleNotFoundError 时，系统将生成安装建议并在确认后执行一次安装与重试)',
              '(When ModuleNotFoundError appears, the app suggests an install command and executes once after confirmation)'
            )}
          </span>
        </span>
      </label>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={settings.scriptServerEnabled === true}
          onChange={(e) => setSettings({ ...settings, scriptServerEnabled: e.target.checked })}
          className="accent-accent"
        />
        <span className="text-sm">
          {txt('启用脚本服务器', 'Enable Script Server')}
        </span>
      </label>
      <Field
        label={txt('脚本服务器地址', 'Script Server Base URL')}
        hint={txt('例如 http://192.168.1.20:8787。仅用于脚本上传与下载。', 'Example: http://192.168.1.20:8787. Used for script upload/download only.')}
      >
        <input
          className="input font-mono"
          value={settings.scriptServerBaseUrl ?? ''}
          onChange={(e) => setSettings({ ...settings, scriptServerBaseUrl: e.target.value })}
          placeholder="http://127.0.0.1:8787"
          disabled={!settings.scriptServerEnabled}
        />
      </Field>

      {showAdvanced && (
        <div className="text-xs text-ink-faint border border-line rounded-md p-3 bg-bg-elev">
        <strong className="text-ink-dim">{txt('关于模型:', 'About Model:')}</strong>
        {txt(
          '任务里可选择 AI 提供方：opencode（Agent，可文件操作）或 OpenAI 兼容接口（仅分析）。opencode 用自身配置；OpenAI 用本页配置。',
          'Task can select AI provider: opencode (agent/file operations) or OpenAI-compatible API (analysis only).'
        )}
        </div>
      )}
      {showAdvanced && (
        <div className="card p-4 space-y-3">
        <div className="font-medium">{txt('配置与引导', 'Config & Onboarding')}</div>
        <div className="flex gap-2 flex-wrap">
          <button
            className="btn"
            onClick={async () => {
              const r = await unwrap(api.app.exportConfig())
              if (r) setToast(txt(`导出完成，共 ${r.taskCount} 个任务`, `Export completed: ${r.taskCount} tasks`))
            }}
          >
            {txt('导出配置', 'Export Config')}
          </button>
          <button
            className="btn"
            onClick={async () => {
              const r = await unwrap(api.app.importConfig())
              if (r) {
                const warn = r.warnings.length ? `；${r.warnings.join('；')}` : ''
                setToast(
                  txt(
                    `导入完成：新增 ${r.created}，更新 ${r.updated}，跳过 ${r.skipped}${warn}`,
                    `Import completed: +${r.created}, updated ${r.updated}, skipped ${r.skipped}`
                  )
                )
              }
            }}
          >
            {txt('导入配置', 'Import Config')}
          </button>
          <button className="btn" onClick={runHealthCheck}>
            {txt('环境健康检查', 'Health Check')}
          </button>
          <button
            className="btn"
            onClick={async () => {
              const next = await unwrap(api.settings.set({ onboardingDone: true }))
              setSettings(next)
              setToast(txt('已标记为“首次引导已完成”', 'Onboarding marked as completed'))
            }}
          >
            {txt('标记已完成引导', 'Mark Onboarding Done')}
          </button>
        </div>
        {health && (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className={'card p-2 ' + (health.pythonOk ? 'border-accent/40' : 'border-danger/40')}>
              Python: {health.pythonOk ? txt('正常', 'OK') : txt('异常', 'Error')}
            </div>
            <div className={'card p-2 ' + (health.opencodeReady ? 'border-accent/40' : 'border-danger/40')}>
              opencode: {health.opencodeState}
            </div>
            <div className="card p-2">{txt('任务数', 'Tasks')}: {health.tasksTotal}</div>
            <div className={'card p-2 ' + (health.missingScripts === 0 ? 'border-accent/40' : 'border-warn/40')}>
              {txt('缺脚本任务', 'Missing Scripts')}: {health.missingScripts}
            </div>
          </div>
        )}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? txt('保存中...', 'Saving...') : txt('保存', 'Save')}
        </button>
        <button
          className="btn"
          onClick={async () => {
            await unwrap(api.settings.openTasksFolder())
          }}
        >
          {txt('打开 tasks 目录', 'Open tasks folder')}
        </button>
      </div>
    </div>
  )
}

function findDupHeader(headers: OpenAiHeaderItem[]): string | null {
  const set = new Set<string>()
  for (const h of headers) {
    const k = String(h.key ?? '').trim().toLowerCase()
    if (!k) continue
    if (set.has(k)) return h.key
    set.add(k)
  }
  return null
}

function OpenAiHeadersEditor({
  value,
  onChange,
  txt
}: {
  value: OpenAiHeaderItem[]
  onChange: (items: OpenAiHeaderItem[]) => void
  txt: (zh: string, en: string) => string
}) {
  const updateAt = (idx: number, patch: Partial<OpenAiHeaderItem>) => {
    const next = value.map((x, i) => (i === idx ? { ...x, ...patch } : x))
    onChange(next)
  }
  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx))
  }
  const dup = findDupHeader(value)
  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="label">{txt('OpenAI 自定义 Headers', 'OpenAI Custom Headers')}</div>
        <button
          className="btn"
          type="button"
          onClick={() => onChange([...(value ?? []), { key: '', value: '', enabled: true }])}
        >
          {txt('新增 Header', 'Add Header')}
        </button>
      </div>
      <div className="text-xs text-ink-faint">
        {txt(
          '仅作用于 OpenAI 兼容接口。Authorization 与 Content-Type 为保留头，不能覆盖。',
          'Only for OpenAI-compatible API. Authorization and Content-Type are reserved.'
        )}
      </div>
      {dup && <div className="text-xs text-danger">{txt(`检测到重复 Header：${dup}`, `Duplicate header: ${dup}`)}</div>}
      {value.length === 0 && <div className="text-xs text-ink-faint">{txt('尚未配置', 'No headers configured')}</div>}
      {value.map((item, idx) => (
        <div key={idx} className="grid grid-cols-12 gap-2 items-center">
          <input
            className="col-span-4 input font-mono"
            placeholder="X-API-Key"
            value={item.key}
            onChange={(e) => updateAt(idx, { key: e.target.value })}
          />
          <input
            className="col-span-6 input font-mono"
            placeholder="value"
            value={item.value}
            onChange={(e) => updateAt(idx, { value: e.target.value })}
          />
          <label className="col-span-1 flex items-center justify-center">
            <input
              type="checkbox"
              checked={item.enabled !== false}
              onChange={(e) => updateAt(idx, { enabled: e.target.checked })}
            />
          </label>
          <button className="col-span-1 btn" type="button" onClick={() => removeAt(idx)}>
            {txt('删除', 'Delete')}
          </button>
        </div>
      ))}
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <div className="label mb-1.5">{label}</div>
      {children}
      {hint && <div className="text-xs text-ink-faint mt-1">{hint}</div>}
    </label>
  )
}

// ============================================================
// Python 路径 + 检测
// ============================================================

function PythonPathField({
  value,
  onChange,
  onToast
}: {
  value: string
  onChange: (v: string) => void
  onToast: (s: string) => void
}) {
  const [info, setInfo] = useState<PythonInfo | null>(null)
  const [checking, setChecking] = useState(false)

  const doCheck = async () => {
    setChecking(true)
    try {
      const data = await unwrap(api.python.check(value))
      setInfo(data)
      if (!data.ok) onToast(`检测失败：${data.errorType ?? 'unknown'}`)
    } catch (e) {
      onToast((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const envBadge = (kind: string): { label: string; cls: string } => {
    const map: Record<string, { label: string; cls: string }> = {
      conda: { label: 'conda', cls: 'bg-green-500/20 text-green-400' },
      uv: { label: 'uv', cls: 'bg-purple-500/20 text-purple-400' },
      venv: { label: 'venv', cls: 'bg-blue-500/20 text-blue-400' },
      system: { label: 'system', cls: 'bg-ink-faint/20 text-ink-dim' },
      unknown: { label: 'unknown', cls: 'bg-line text-ink-faint' }
    }
    return map[kind] ?? map.unknown
  }

  return (
    <div>
      <div className="label mb-1.5">Python 路径</div>
      <div className="flex gap-2">
        <input
          className="input font-mono flex-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="python / py / absolute path"
        />
        <button className="btn" onClick={doCheck} disabled={checking}>
          {checking ? '检测中...' : '执行检测'}
        </button>
      </div>
      <div className="text-xs text-ink-faint mt-1">
        任务执行使用的 Python 可执行文件。Windows 11 建议使用 <code>py</code> 或绝对路径
        （系统默认 <code>python</code> 可能跳转到 Microsoft Store）。
      </div>

      {info && info.ok && (
        <div className="mt-2 card p-3 border-accent/30 bg-accent/5">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-accent">✓</span>
            <span className="text-sm font-medium">{info.version}</span>
            <span className={'tag ' + envBadge(info.envKind).cls}>{envBadge(info.envKind).label}</span>
            {info.pipAvailable ? (
              <span className="tag bg-accent/20 text-accent">pip ✓</span>
            ) : (
              <span className="tag bg-warn/20 text-warn">no pip</span>
            )}
          </div>
          {info.envDetail && (
            <div className="text-xs text-ink-dim font-mono break-all">{info.envDetail}</div>
          )}
          {info.executable && info.executable !== info.pythonPath && (
            <div className="text-xs text-ink-faint font-mono mt-1 break-all">
              → {info.executable}
            </div>
          )}
        </div>
      )}

      {info && !info.ok && (
        <div className="mt-2 card p-3 border-danger/30 bg-danger/5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-danger">✗</span>
            <span className="text-sm font-medium">检测未通过</span>
            <span className="tag bg-danger/20 text-danger">{info.errorType}</span>
          </div>
          <pre className="text-xs text-ink-dim whitespace-pre-wrap break-words font-mono">
            {info.error}
          </pre>
        </div>
      )}
    </div>
  )
}

// ============================================================
// opencode 状态面板 (和之前一致)
// ============================================================

function OpencodeSection({ onToast }: { onToast: (s: string) => void }) {
  const [status, setStatus] = useState<OpencodeStatus | null>(null)
  const [log, setLog] = useState('')
  const [showLog, setShowLog] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const s = await unwrap(api.opencode.status())
      setStatus(s)
    } catch {
      // 首次加载时可能因为 UI 比主进程快,忽略
    }
  }

  useEffect(() => {
    refresh()
    const off = api.events.on((e: MainEvent) => {
      if (e.type === 'opencode:status') setStatus(e.status)
    })
    const t = setInterval(refresh, 2000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  const loadLog = async () => {
    try {
      const s = await unwrap(api.opencode.log())
      setLog(s ?? '')
    } catch (e) {
      onToast((e as Error).message)
    }
  }

  const onRestart = async () => {
    setBusy(true)
    try {
      await unwrap(api.opencode.restart())
      onToast('opencode 重启完成')
      await loadLog()
    } catch (e) {
      onToast((e as Error).message)
      await loadLog()
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const state = status?.state ?? 'stopped'

  const dotColor = {
    ready: 'bg-green-500',
    starting: 'bg-yellow-500',
    crashed: 'bg-red-500',
    missing: 'bg-red-500',
    stopped: 'bg-gray-500'
  }[state]

  const stateLabel = {
    ready: '运行中',
    starting: '启动中',
    crashed: '异常退出',
    missing: '未检测到',
    stopped: '未启动'
  }[state]

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotColor}`} />
          <span className="font-medium">opencode 状态</span>
          <span className="text-sm text-ink-dim">{stateLabel}</span>
          {status?.baseUrl && (
            <span className="text-xs font-mono text-ink-faint truncate">{status.baseUrl}</span>
          )}
          {status?.pid && <span className="text-xs text-ink-faint">PID {status.pid}</span>}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              await loadLog()
              setShowLog((v) => !v)
            }}
          >
            {showLog ? '收起日志' : '查看日志'}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={onRestart}>
            {busy ? '...' : state === 'ready' ? '重启服务' : '启动服务'}
          </button>
        </div>
      </div>

      {status?.lastError && (state === 'crashed' || state === 'missing') && (
        <div className="text-sm text-danger whitespace-pre-wrap break-words bg-bg-raised p-2 rounded">
          {status.lastError}
        </div>
      )}

      {state === 'missing' && (
        <div className="text-xs text-ink-dim">
          建议先安装 opencode（<code className="text-accent">npm i -g opencode-ai</code>），
          并在命令行执行一次 <code className="text-accent">opencode</code> 完成 provider 配置，
          然后返回此处启动服务。
        </div>
      )}

      {showLog && (
        <pre className="text-xs font-mono bg-bg-raised p-3 rounded-md max-h-64 overflow-auto whitespace-pre-wrap break-words">
          {log || '(暂无日志)'}
        </pre>
      )}
    </div>
  )
}
