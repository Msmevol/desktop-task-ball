import type { Task, Run, PromptPreview } from '@shared/types'

const KNOWN_VARS = new Set([
  'task.name',
  'task.description',
  'run.runId',
  'run.exitCode',
  'run.durationMs',
  'args',
  'scriptOutput',
  'stdout',
  'stderr'
])

interface Context {
  task: Task
  run: Partial<Run>
  args: Record<string, unknown>
  scriptOutput: unknown
  stdout: string
  stderr: string
}

function resolve(key: string, ctx: Context): string {
  switch (key) {
    case 'task.name':
      return ctx.task.name
    case 'task.description':
      return ctx.task.description ?? ''
    case 'run.runId':
      return ctx.run.runId ?? ''
    case 'run.exitCode':
      return ctx.run.exitCode !== undefined ? String(ctx.run.exitCode) : ''
    case 'run.durationMs':
      return ctx.run.durationMs !== undefined ? String(ctx.run.durationMs) : ''
    case 'args':
      return JSON.stringify(ctx.args, null, 2)
    case 'scriptOutput':
      return ctx.scriptOutput !== undefined
        ? typeof ctx.scriptOutput === 'string'
          ? ctx.scriptOutput
          : JSON.stringify(ctx.scriptOutput, null, 2)
        : ''
    case 'stdout':
      return ctx.stdout
    case 'stderr':
      return ctx.stderr
    default:
      return ''
  }
}

/** 替换模板中的 {{var}} */
export function renderTemplate(
  template: string,
  ctx: Context
): { rendered: string; missingVars: string[] } {
  const missing = new Set<string>()
  const rendered = template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key) => {
    if (!KNOWN_VARS.has(key)) {
      missing.add(key)
      return ''
    }
    return resolve(key, ctx)
  })
  return { rendered, missingVars: Array.from(missing) }
}

/** 用于编辑器预览：若有历史 run 就用真实数据，否则用占位 */
export function buildPreview(
  task: Task,
  latestRun: Run | null
): PromptPreview {
  const ctx: Context = {
    task,
    run: latestRun ?? { runId: '（暂无历史运行）', exitCode: 0, durationMs: 0 },
    args: latestRun?.inputArgs ?? {},
    scriptOutput: latestRun?.scriptOutputJson,
    stdout: latestRun?.stdoutExcerpt ?? '',
    stderr: latestRun?.stderrExcerpt ?? ''
  }
  const sys = renderTemplate(task.systemPrompt, ctx)
  const usr = renderTemplate(task.userPromptTemplate, ctx)
  return {
    systemPrompt: sys.rendered,
    userPrompt: usr.rendered,
    missingVars: Array.from(new Set([...sys.missingVars, ...usr.missingVars]))
  }
}
