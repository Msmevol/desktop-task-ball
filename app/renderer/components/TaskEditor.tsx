import { useEffect, useState } from 'react'
import { api, unwrap } from '../api'
import { useStore } from '../store'
import type { Task, TaskInput, ArgDef, PromptPreview, ArgSchemaGenerateResult } from '@shared/types'

const AVAILABLE_VARS = [
  'task.name',
  'task.description',
  'run.runId',
  'run.exitCode',
  'run.durationMs',
  'args',
  'scriptOutput',
  'stdout',
  'stderr'
]

const DEFAULT_SYSTEM = `你是任务推理助手。
目标：基于任务上下文与脚本结果，给出可执行结论，不编造事实。
输出协议：只输出 JSON，字段为 run_id, summary, details, need_notify, notify_title, notify_body。
其中 need_notify 为 boolean，只有确实需要提醒用户时才为 true；details 使用 Markdown，优先给结论、证据、建议。`

const DEFAULT_USER = `任务: {{task.name}}
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
输出协议：只输出 JSON，字段为 run_id, summary, details, need_notify, notify_title, notify_body。
need_notify 为 boolean，只有确实需要提醒用户时才为 true；details 使用 Markdown，固定三段：
## 根因判断
## 修改建议
## 验证步骤`

type Form = TaskInput & { argsList: Array<{ key: string; def: ArgDef }> }

function taskToForm(t: Task | null): Form {
  if (!t) {
    return {
      name: '',
      tag: '',
      description: '',
      scriptPath: '',
      argsSchema: {},
      argsList: [],
      timeoutSec: 600,
      scheduleEnabled: false,
      scheduleEveryMin: 60,
      retryCount: 0,
      retryDelaySec: 15,
      notifyOnFailure: false,
      notifyOnTimeout: false,
      aiEnabled: false,
      aiProvider: 'opencode',
      failureAiEnabled: false,
      failureAiPrompt: DEFAULT_FAILURE_AI_PROMPT,
      systemPrompt: DEFAULT_SYSTEM,
      userPromptTemplate: DEFAULT_USER,
      notifyEnabled: false
    }
  }
  return {
    name: t.name,
    tag: t.tag ?? '',
    description: t.description ?? '',
    scriptPath: t.scriptPath,
    argsSchema: t.argsSchema,
    argsList: Object.entries(t.argsSchema).map(([key, def]) => ({ key, def })),
    timeoutSec: t.timeoutSec,
    scheduleEnabled: t.scheduleEnabled ?? false,
    scheduleEveryMin: t.scheduleEveryMin ?? 60,
    retryCount: t.retryCount ?? 0,
    retryDelaySec: t.retryDelaySec ?? 15,
    notifyOnFailure: t.notifyOnFailure ?? false,
    notifyOnTimeout: t.notifyOnTimeout ?? false,
    aiEnabled: t.aiEnabled ?? false,
    aiProvider: t.aiProvider ?? 'opencode',
    failureAiEnabled: t.failureAiEnabled ?? false,
    failureAiPrompt: t.failureAiPrompt || DEFAULT_FAILURE_AI_PROMPT,
    systemPrompt: t.systemPrompt,
    userPromptTemplate: t.userPromptTemplate,
    notifyEnabled: t.notifyEnabled ?? false
  }
}

function formToInput(f: Form): TaskInput {
  const argsSchema: Record<string, ArgDef> = {}
  for (const { key, def } of f.argsList) {
    if (!key.trim()) continue
    argsSchema[key.trim()] = def
  }
  return {
    name: f.name.trim(),
    tag: f.tag?.trim() || undefined,
    description: f.description?.trim() || undefined,
    scriptPath: f.scriptPath.trim(),
    argsSchema,
    timeoutSec: Number(f.timeoutSec) || 600,
    scheduleEnabled: !!f.scheduleEnabled,
    scheduleEveryMin: f.scheduleEnabled ? Math.max(1, Number(f.scheduleEveryMin) || 60) : undefined,
    retryCount: Math.max(0, Number(f.retryCount) || 0),
    retryDelaySec: Math.max(1, Number(f.retryDelaySec) || 15),
    notifyOnFailure: !!f.notifyOnFailure,
    notifyOnTimeout: !!f.notifyOnTimeout,
    aiEnabled: !!f.aiEnabled,
    aiProvider: f.aiProvider ?? 'opencode',
    failureAiEnabled: !!f.failureAiEnabled,
    failureAiPrompt: f.failureAiPrompt?.trim() || DEFAULT_FAILURE_AI_PROMPT,
    systemPrompt: f.systemPrompt,
    userPromptTemplate: f.userPromptTemplate,
    notifyEnabled: f.notifyEnabled
  }
}

function schemaToArgsList(schema: Record<string, ArgDef>): Array<{ key: string; def: ArgDef }> {
  return Object.entries(schema).map(([key, def]) => ({ key, def }))
}

const SECTION_LABELS: Record<'basic' | 'args' | 'prompt', string> = {
  basic: '基本',
  args: '参数',
  prompt: '高级'
}

export function TaskEditor() {
  const {
    editingTaskId,
    editTask,
    refreshTasks,
    refreshRuns,
    selectRun,
    setTab,
    newTaskScriptPath,
    setNewTaskScriptPath,
    setToast,
    txt
  } = useStore()
  const isNew = editingTaskId === 'new'
  const [form, setForm] = useState<Form>(taskToForm(null))
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<PromptPreview | null>(null)
  const [section, setSection] = useState<'basic' | 'args' | 'prompt'>('basic')
  const [existingScripts, setExistingScripts] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [generatingSchema, setGeneratingSchema] = useState(false)
  const [schemaHint, setSchemaHint] = useState<{ type: 'info' | 'warn'; text: string } | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  useEffect(() => {
    if (!showAdvanced && section === 'prompt') setSection('basic')
  }, [showAdvanced, section])

  useEffect(() => {
    if (isNew) {
      setForm(taskToForm(null))
      if (newTaskScriptPath) {
        setForm((f) => ({ ...f, scriptPath: newTaskScriptPath }))
        setSchemaHint({
          type: 'info',
          text: txt(`已自动填入脚本：${newTaskScriptPath}`, `Script prefilled: ${newTaskScriptPath}`)
        })
        setNewTaskScriptPath(null)
      }
      return
    }
    if (editingTaskId && typeof editingTaskId === 'string') {
      api.tasks.get(editingTaskId).then((r) => {
        if (r.ok) setForm(taskToForm(r.data))
      })
    }
  }, [editingTaskId, isNew, newTaskScriptPath, setNewTaskScriptPath, txt])

  // 拉已有脚本列表（供 datalist 下拉）
  useEffect(() => {
    refreshScripts()
  }, [editingTaskId])

  const refreshScripts = async () => {
    try {
      const list = await unwrap(api.scripts.list())
      setExistingScripts(list)
    } catch (e) {
      console.warn('脚本列表加载失败:', e)
    }
  }

  const uploadScriptHandler = async () => {
    setUploading(true)
    try {
      const result = await unwrap(api.scripts.upload())
      if (!result) return // 用户已取消操作
      setForm((f) => ({ ...f, scriptPath: result.fileName }))
      await refreshScripts()
      await autoGenerateSchema(result.fileName)
      setToast(
        result.overwritten
          ? txt(`脚本已覆盖：${result.fileName}`, `Script overwritten: ${result.fileName}`)
          : txt(`脚本已上传：${result.fileName}`, `Script uploaded: ${result.fileName}`)
      )
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const applySchemaResult = (res: ArgSchemaGenerateResult) => {
    const list = schemaToArgsList(res.argsSchema)
    if (list.length > 0) {
      setForm((f) => ({ ...f, argsList: list }))
      setSchemaHint({
        type: 'info',
        text:
          res.source === 'ai'
            ? txt('已通过 AI 自动生成参数，请确认后保存。', 'Parameters generated by AI. Please review and save.')
            : txt('已自动解析脚本参数，请确认后保存。', 'Script parameters were auto-detected. Please review and save.')
      })
      if (res.source === 'ai') {
        setToast(txt('已通过 AI 自动生成参数，请确认后保存。', 'Parameters generated by AI. Please review and save.'))
      } else {
        setToast(txt('已自动解析脚本参数。', 'Script parameters were auto-detected.'))
      }
      return
    }
    if (res.needsDeveloperInput) {
      setSchemaHint({ type: 'warn', text: res.message })
      setToast(res.message)
      return
    }
    setSchemaHint({
      type: 'warn',
      text: txt('未识别到可用参数，请手动补全。', 'No usable parameters found. Please add them manually.')
    })
  }

  const autoGenerateSchema = async (scriptPath?: string) => {
    const target = (scriptPath ?? form.scriptPath ?? '').trim()
    if (!target) return
    setGeneratingSchema(true)
    try {
      const result = await unwrap(api.scripts.generateSchema({ scriptPath: target }))
      applySchemaResult(result)
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setGeneratingSchema(false)
    }
  }

  const save = async () => {
    if (!form.name.trim()) {
      setToast(txt('任务名称不能为空', 'Task name is required'))
      return
    }
    if (!form.scriptPath.trim()) {
      setToast(txt('请选择或上传一个脚本', 'Please select or upload a script'))
      return
    }
    setBusy(true)
    try {
      const input = formToInput(form)
      if (isNew) {
        const created = await unwrap(api.tasks.create(input))
        setToast(txt('任务已创建', 'Task created'))
        editTask(created.id)
      } else if (editingTaskId) {
        await unwrap(api.tasks.update(editingTaskId as string, input))
        setToast(txt('已保存', 'Saved'))
      }
      await refreshTasks()
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const buildRunArgsFromSchema = (schema: Record<string, ArgDef>) => {
    const args: Record<string, unknown> = {}
    const missingRequired: string[] = []
    for (const [name, def] of Object.entries(schema)) {
      if (def.type === 'boolean') {
        args[name] = def.default === true || def.default === 'true'
        continue
      }
      const value = def.default
      const isEmpty = value === undefined || value === null || String(value).trim() === ''
      if (def.required && isEmpty) {
        missingRequired.push(name)
        continue
      }
      if (def.type === 'number') {
        if (isEmpty) continue
        const n = Number(value)
        if (Number.isFinite(n)) args[name] = n
        continue
      }
      if (!isEmpty) args[name] = String(value)
    }
    return { args, missingRequired }
  }

  const saveAndRun = async () => {
    if (!form.name.trim()) {
      setToast(txt('任务名称不能为空', 'Task name is required'))
      return
    }
    if (!form.scriptPath.trim()) {
      setToast(txt('请选择或上传一个脚本', 'Please select or upload a script'))
      return
    }
    setBusy(true)
    try {
      const input = formToInput(form)
      let taskId = editingTaskId as string
      if (isNew) {
        const created = await unwrap(api.tasks.create(input))
        taskId = created.id
      } else if (editingTaskId) {
        await unwrap(api.tasks.update(editingTaskId as string, input))
      }
      const { args, missingRequired } = buildRunArgsFromSchema(input.argsSchema)
      if (missingRequired.length > 0) {
        setToast(
          txt(
            `已保存，但仍有必填参数缺省：${missingRequired.join(', ')}。请先补全后再运行。`,
            `Saved, but required defaults are missing: ${missingRequired.join(', ')}. Please fill them before running.`
          )
        )
        if (isNew && taskId) editTask(taskId)
        setSection('args')
        return
      }
      const { runId } = await unwrap(api.tasks.run(taskId, args))
      await refreshTasks()
      await refreshRuns()
      setTab('runs')
      selectRun(runId)
      if (isNew && taskId) editTask(taskId)
      setToast(txt(`已保存并启动运行：${runId}`, `Saved and started run: ${runId}`))
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doPreview = async () => {
    if (isNew) {
      setToast(txt('请先保存任务，再使用真实运行数据进行预览。', 'Save the task before previewing with real run data.'))
      return
    }
    try {
      const p = await unwrap(api.prompt.preview(editingTaskId as string))
      setPreview(p)
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h2 className="text-lg font-bold">{isNew ? txt('新建任务', 'New Task') : txt('编辑任务', 'Edit Task')}</h2>
          <div className="text-xs text-ink-faint mt-0.5">{txt('配置脚本、参数、调度策略与 AI 分析提示词。', 'Configure scripts, arguments, schedules and AI prompts.')}</div>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => editTask(null)} disabled={busy}>
            {txt('关闭', 'Close')}
          </button>
          <button className="btn" onClick={saveAndRun} disabled={busy}>
            {busy ? txt('提交中...', 'Submitting...') : txt('保存并运行', 'Save & Run')}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? txt('保存中...', 'Saving...') : txt('保存', 'Save')}
          </button>
        </div>
      </div>

      <div className="flex gap-1 text-xs border-b border-line">
        {(['basic', 'args', ...(showAdvanced ? (['prompt'] as const) : ([] as const))] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={
              'px-3 h-8 border-b-2 -mb-px transition-colors tracking-wider ' +
              (section === s
                ? 'text-accent border-accent'
                : 'text-ink-dim border-transparent hover:text-ink')
            }
          >
            {SECTION_LABELS[s]}
          </button>
        ))}
      </div>

      {section === 'basic' && (
        <div className="space-y-4">
          <Field label={txt('名称', 'Name')}>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label={txt('描述', 'Description')}>
            <input
              className="input"
              value={form.description ?? ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <Field label={txt('标签', 'Tag')}>
            <input
              className="input"
              placeholder={txt('例如：工作 / 监控 / 每日', 'e.g. work / monitor / daily')}
              value={form.tag ?? ''}
              onChange={(e) => setForm({ ...form, tag: e.target.value })}
            />
          </Field>
          <Field label={txt('脚本', 'Script')}>
            <div className="flex gap-2 flex-wrap">
              <input
                className="input font-mono flex-1"
                placeholder="example.py / deploy.bat / task.ps1"
                list="task-scripts-list"
                value={form.scriptPath}
                onChange={(e) => setForm({ ...form, scriptPath: e.target.value })}
                onBlur={() => {
                  if (!form.scriptPath.trim()) return
                  if (form.argsList.length > 0) return
                  void autoGenerateSchema(form.scriptPath)
                }}
              />
              <datalist id="task-scripts-list">
                {existingScripts.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <button
                type="button"
                className="btn"
                onClick={uploadScriptHandler}
                disabled={uploading}
                title="从本地选择 .py/.bat/.cmd/.ps1 脚本并复制到 tasks/ 目录"
              >
                {uploading ? '上传中...' : '上传脚本'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => autoGenerateSchema()}
                disabled={generatingSchema || !form.scriptPath.trim()}
                title={txt('自动检测参数；无标准参数时按 AI 配置补全', 'Auto-detect parameters and use AI fallback if needed')}
              >
                {generatingSchema ? txt('生成中...', 'Generating...') : txt('自动生成参数', 'Auto Generate Params')}
              </button>
            </div>
            {schemaHint && (
              <div
                className={
                  'mt-2 rounded border px-3 py-2 text-xs ' +
                  (schemaHint.type === 'warn'
                    ? 'border-warn/40 bg-warn/10 text-warn'
                    : 'border-accent/40 bg-accent/10 text-ink')
                }
              >
                <div>{schemaHint.text}</div>
                {schemaHint.type === 'warn' && (
                  <div className="mt-2 flex gap-2">
                    <button className="btn h-7 px-2 text-xs" onClick={() => autoGenerateSchema()} disabled={generatingSchema}>
                      {txt('重试生成', 'Retry')}
                    </button>
                    <button
                      className="btn h-7 px-2 text-xs"
                      onClick={() =>
                        setForm((f) =>
                          f.argsList.length > 0
                            ? f
                            : { ...f, argsList: [{ key: '', def: { type: 'string' } }] }
                        )
                      }
                    >
                      {txt('手动补全参数', 'Add Manually')}
                    </button>
                    <button
                      className="btn h-7 px-2 text-xs"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          argsList:
                            f.argsList.length > 0
                              ? f.argsList
                              : [{ key: 'target', def: { type: 'string', required: true, description: '目标地址' } }]
                        }))
                      }
                    >
                      {txt('填充示例参数', 'Fill Example')}
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="text-xs text-ink-faint mt-1">
              {existingScripts.length > 0
                ? `当前已有 ${existingScripts.length} 个脚本，可在输入框下拉选择。建议点击“自动生成参数”。`
                : '当前未检测到脚本。请使用“上传脚本”从本地选择 .py/.bat/.cmd/.ps1 文件。'}
            </div>
          </Field>
          <button className="btn btn-ghost" onClick={() => setShowAdvanced((v) => !v)} type="button">
            {showAdvanced ? txt('收起高级设置', 'Hide advanced settings') : txt('展开高级设置', 'Show advanced settings')}
          </button>
          {!showAdvanced && (
            <div className="text-xs text-ink-faint">
              {txt('默认配置已可直接使用。仅在需要定时、重试、通知或 AI 细化时再展开。', 'Default settings are enough for quick use. Expand only when you need schedule, retry, notify or AI tuning.')}
            </div>
          )}
          {showAdvanced && (
            <>
          <div className="text-xs text-ink-faint border border-line rounded-md p-2 bg-bg-elev">
            {txt('高级设置：调度、重试、通知和 AI 分析。', 'Advanced: schedule, retry, notification and AI analysis.')}
          </div>
          <Field label="超时（秒）">
            <input
              className="input"
              type="number"
              value={form.timeoutSec}
              onChange={(e) => setForm({ ...form, timeoutSec: Number(e.target.value) })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!form.scheduleEnabled}
                onChange={(e) => setForm({ ...form, scheduleEnabled: e.target.checked })}
                className="accent-accent"
              />
              <span className="text-sm">启用定时运行</span>
            </label>
            <Field label="每隔多少分钟运行">
              <input
                className="input"
                type="number"
                min={1}
                value={form.scheduleEveryMin ?? 60}
                onChange={(e) => setForm({ ...form, scheduleEveryMin: Number(e.target.value) })}
                disabled={!form.scheduleEnabled}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="失败自动重试次数">
              <input
                className="input"
                type="number"
                min={0}
                value={form.retryCount ?? 0}
                onChange={(e) => setForm({ ...form, retryCount: Number(e.target.value) })}
              />
            </Field>
            <Field label="重试间隔（秒）">
              <input
                className="input"
                type="number"
                min={1}
                value={form.retryDelaySec ?? 15}
                onChange={(e) => setForm({ ...form, retryDelaySec: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.notifyOnFailure !== false}
                onChange={(e) => setForm({ ...form, notifyOnFailure: e.target.checked })}
                className="accent-accent"
              />
              <span className="text-sm">失败时通知</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.notifyOnTimeout !== false}
                onChange={(e) => setForm({ ...form, notifyOnTimeout: e.target.checked })}
                className="accent-accent"
              />
              <span className="text-sm">超时时通知</span>
            </label>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.notifyEnabled}
              onChange={(e) => setForm({ ...form, notifyEnabled: e.target.checked })}
              className="accent-accent"
            />
            <span className="text-sm">成功后通知（可选，不由 AI 决定）</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.aiEnabled !== false}
              onChange={(e) => setForm({ ...form, aiEnabled: e.target.checked })}
              className="accent-accent"
            />
            <span className="text-sm">启用成功 AI（脚本成功后做推理）</span>
          </label>
          <Field label="AI 提供方">
            <select
              className="input"
              value={form.aiProvider ?? 'opencode'}
              onChange={(e) =>
                setForm({ ...form, aiProvider: e.target.value === 'openai' ? 'openai' : 'opencode' })
              }
              disabled={form.aiEnabled === false}
            >
              <option value="opencode">opencode（Agent，可文件操作）</option>
              <option value="openai">OpenAI 兼容接口（仅分析）</option>
            </select>
          </Field>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.failureAiEnabled !== false}
              onChange={(e) => setForm({ ...form, failureAiEnabled: e.target.checked })}
              className="accent-accent"
            />
            <span className="text-sm">启用失败 AI（失败诊断/缺包建议）</span>
          </label>
            </>
          )}
        </div>
      )}

      {section === 'args' && (
        <ArgsEditor list={form.argsList} onChange={(argsList) => setForm({ ...form, argsList })} />
      )}

      {section === 'prompt' && (
        <div className="space-y-4">
          <div className="text-xs text-ink-faint border border-line rounded-md p-2 bg-bg-elev">
            {txt('高级设置：仅在需要自定义 AI 分析行为时修改。', 'Advanced: edit only if you need custom AI analysis behavior.')}
          </div>
          {form.aiEnabled === false && (
            <div className="card p-3 text-sm text-ink-dim">
              当前任务已关闭 AI 分析，Prompt 不会在运行时生效。
            </div>
          )}
          <div className="flex gap-2">
            <button className="btn" onClick={doPreview}>
              用最近一次运行预览
            </button>
          </div>
          <Field label="System Prompt">
            <textarea
              className="textarea min-h-[120px]"
              value={form.systemPrompt}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
          </Field>
          <Field label="成功 AI Prompt 模板">
            <textarea
              className="textarea min-h-[200px]"
              value={form.userPromptTemplate}
              onChange={(e) => setForm({ ...form, userPromptTemplate: e.target.value })}
            />
          </Field>
          <Field label="失败 AI Prompt">
            <textarea
              className="textarea min-h-[140px]"
              value={form.failureAiPrompt ?? ''}
              onChange={(e) => setForm({ ...form, failureAiPrompt: e.target.value })}
              placeholder={DEFAULT_FAILURE_AI_PROMPT}
            />
          </Field>
          <div className="card p-3">
            <div className="label mb-2">可用变量</div>
            <div className="flex flex-wrap gap-1.5">
              {AVAILABLE_VARS.map((v) => (
                <button
                  key={v}
                  className="tag bg-bg-raised border border-line text-ink-dim hover:text-accent hover:border-accent/50 px-2"
                  onClick={() => {
                    const t = `{{${v}}}`
                    setForm({ ...form, userPromptTemplate: form.userPromptTemplate + t })
                  }}
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
          </div>

          {preview && (
            <div className="card p-3 space-y-3">
              <div>
                <div className="label mb-1">渲染后的 System</div>
                <pre className="text-xs font-mono whitespace-pre-wrap bg-bg p-2 rounded border border-line">
                  {preview.systemPrompt}
                </pre>
              </div>
              <div>
                <div className="label mb-1">渲染后的 User</div>
                <pre className="text-xs font-mono whitespace-pre-wrap bg-bg p-2 rounded border border-line max-h-[300px] overflow-auto">
                  {preview.userPrompt}
                </pre>
              </div>
              {preview.missingVars.length > 0 && (
                <div className="text-xs text-warn">
                  未知变量：{preview.missingVars.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="label mb-1.5">{label}</div>
      {children}
    </label>
  )
}

function ArgsEditor({
  list,
  onChange
}: {
  list: Array<{ key: string; def: ArgDef }>
  onChange: (list: Array<{ key: string; def: ArgDef }>) => void
}) {
  const add = () => onChange([...list, { key: '', def: { type: 'string' } }])
  const update = (i: number, patch: Partial<{ key: string; def: ArgDef }>) => {
    const next = list.slice()
    next[i] = { ...next[i], ...patch, def: { ...next[i].def, ...(patch.def ?? {}) } }
    onChange(next)
  }
  const remove = (i: number) => onChange(list.filter((_, j) => j !== i))

  return (
    <div className="space-y-3">
      {list.length === 0 && (
        <div className="text-sm text-ink-dim">当前未配置参数。请点击下方“添加参数”。</div>
      )}
      {list.map((item, i) => (
        <div key={i} className="card p-3 space-y-2">
          <div className="flex gap-2">
            <input
              className="input font-mono flex-1"
              placeholder="参数名"
              value={item.key}
              onChange={(e) => update(i, { key: e.target.value })}
            />
            <select
              className="input w-32"
              value={item.def.type}
              onChange={(e) =>
                update(i, { def: { ...item.def, type: e.target.value as ArgDef['type'] } })
              }
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="enum">enum</option>
            </select>
            <button className="btn btn-danger" onClick={() => remove(i)}>
              ✕
            </button>
          </div>
          <div className="flex gap-2 items-center">
            <label className="flex items-center gap-1.5 text-xs text-ink-dim">
              <input
                type="checkbox"
                checked={!!item.def.required}
                onChange={(e) => update(i, { def: { ...item.def, required: e.target.checked } })}
                className="accent-accent"
              />
              必填
            </label>
            {item.def.type === 'boolean' ? (
              <label className="flex items-center gap-2 text-xs text-ink-dim">
                <input
                  type="checkbox"
                  checked={item.def.default === true || item.def.default === 'true'}
                  onChange={(e) => update(i, { def: { ...item.def, default: e.target.checked } })}
                  className="accent-accent"
                />
                默认勾选（运行时自动传入该参数）
              </label>
            ) : (
              <input
                className="input flex-1"
                placeholder="默认值（可选）"
                value={String(item.def.default ?? '')}
                onChange={(e) =>
                  update(i, { def: { ...item.def, default: e.target.value || undefined } })
                }
              />
            )}
          </div>
          {item.def.type === 'enum' && (
            <input
              className="input"
              placeholder="枚举值，英文逗号分隔：a,b,c"
              value={(item.def.enumValues ?? []).join(',')}
              onChange={(e) =>
                update(i, {
                  def: {
                    ...item.def,
                    enumValues: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  }
                })
              }
            />
          )}
          <input
            className="input"
            placeholder="说明"
            value={item.def.description ?? ''}
            onChange={(e) => update(i, { def: { ...item.def, description: e.target.value } })}
          />
        </div>
      ))}
      <button className="btn" onClick={add}>
        + 添加参数
      </button>
    </div>
  )
}
