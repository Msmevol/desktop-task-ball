import { useEffect, useState } from 'react'
import { api, unwrap } from '../api'
import { useStore } from '../store'
import type { Run, MainEvent } from '@shared/types'

const STAGE_LABEL_ZH: Record<string, string> = {
  running: '运行中',
  done: '完成',
  failed: '失败'
}
const STAGE_LABEL_EN: Record<string, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed'
}
const AI_STAGE_LABEL_ZH: Record<string, string> = {
  pending: '待执行',
  running: '分析中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过'
}
const AI_STAGE_LABEL_EN: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped'
}

const FAIL_REASON_LABEL_ZH: Record<string, string> = {
  script_error: '脚本错误',
  timeout: '超时',
  bad_output: '输出异常',
  ai_error: 'AI 错误',
  python_missing: 'Python 不可用',
  cancelled: '已取消'
}
const FAIL_REASON_LABEL_EN: Record<string, string> = {
  script_error: 'Script Error',
  timeout: 'Timeout',
  bad_output: 'Bad Output',
  ai_error: 'AI Error',
  python_missing: 'Python Missing',
  cancelled: 'Cancelled'
}

export function RunDetail({ runId }: { runId: string }) {
  const { setToast, selectRun, setTab, editTask, txt, lang } = useStore()
  const [run, setRun] = useState<Run | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const r = await unwrap(api.runs.get(runId))
      setRun(r)
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  useEffect(() => {
    refresh()
    const off = api.events.on((e: MainEvent) => {
      if ((e.type === 'run:finished' || e.type === 'run:auto-install') && e.runId === runId) {
        refresh()
      }
    })
    return off
  }, [runId])

  if (!run) return <div className="p-6 text-ink-dim">{txt('数据加载中...', 'Loading data...')}</div>

  const onRetryAi = async () => {
    setBusy(true)
    try {
      const updated = await unwrap(api.runs.retryAi(runId))
      setRun(updated)
      setToast(txt('已提交 AI 重新分析请求', 'AI re-analysis request submitted'))
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onOpenFolder = async () => {
    try {
      await unwrap(api.runs.openLogFolder(runId))
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  const onCancelRun = async () => {
    setBusy(true)
    try {
      const result = await unwrap(api.runs.cancel(runId))
      setToast(result.message)
      await refresh()
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h2 className="text-lg font-bold">{txt('运行详情', 'Run Detail')}</h2>
          <div className="font-mono text-sm text-ink-faint mt-0.5">{run.runId}</div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn" onClick={() => selectRun(null)}>
            {txt('关闭', 'Close')}
          </button>
          <button className="btn" onClick={onOpenFolder}>
            {txt('打开日志目录', 'Open Log Folder')}
          </button>
          {(run.stage === 'running' || run.scriptStage === 'running') && (
            <button className="btn btn-danger" onClick={onCancelRun} disabled={busy}>
              {txt('取消运行', 'Cancel Run')}
            </button>
          )}
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const { runId: newId } = await unwrap(api.tasks.run(run.taskId, run.inputArgs))
                setToast(txt(`已创建新的运行记录：${newId}`, `New run record created: ${newId}`))
                selectRun(newId)
              } catch (e) {
                setToast((e as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {txt('以相同参数再运行', 'Run Again')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <Stat
          label={txt('状态', 'Status')}
          value={(lang === 'en' ? STAGE_LABEL_EN : STAGE_LABEL_ZH)[run.scriptStage ?? run.stage] ?? (run.scriptStage ?? run.stage)}
          accent={stageColor(run.scriptStage ?? run.stage)}
        />
        <Stat
          label="AI"
          value={
            (lang === 'en' ? AI_STAGE_LABEL_EN : AI_STAGE_LABEL_ZH)[run.aiStage ?? 'pending'] ??
            (run.aiStage ?? 'pending')
          }
          accent={run.aiStage === 'failed' ? 'danger' : run.aiStage === 'running' ? 'accent' : 'ink'}
        />
        <Stat label={txt('退出码', 'Exit Code')} value={run.exitCode?.toString() ?? '-'} />
        <Stat
          label={txt('耗时', 'Duration')}
          value={run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '-'}
        />
        <Stat label={txt('已通知', 'Notified')} value={run.notified ? txt('是', 'Yes') : txt('否', 'No')} />
      </div>

      {run.failReason && (
        <div className="panel-card p-3 border-danger/30">
          <div className="label text-danger mb-1">{txt('失败原因', 'Failure reason')}</div>
          <div className="text-base">
            {(lang === 'en' ? FAIL_REASON_LABEL_EN : FAIL_REASON_LABEL_ZH)[run.failReason] ??
              run.failReason}
          </div>
          <div className="mt-2 flex gap-2 flex-wrap">
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const { runId: newId } = await unwrap(api.tasks.run(run.taskId, run.inputArgs))
                  setToast(txt(`已重新运行：${newId}`, `Rerun started: ${newId}`))
                  selectRun(newId)
                  setTab('runs')
                } catch (e) {
                  setToast((e as Error).message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {txt('立即重试', 'Retry Now')}
            </button>
            <button
              className="btn"
              onClick={() => {
                setTab('tasks')
                editTask(run.taskId)
              }}
            >
              {txt('编辑任务参数', 'Edit Task Params')}
            </button>
            <button className="btn" onClick={onOpenFolder}>
              {txt('查看日志目录', 'Open Logs')}
            </button>
          </div>
        </div>
      )}

      {run.command && (
        <Section title={txt('1. 执行命令', '1. Command')} defaultOpen>
          <div className="space-y-2 text-base font-mono">
            <KV label={txt('Python', 'Python')} value={run.command.pythonPath} />
            <KV label={txt('脚本', 'Script')} value={run.command.scriptPath} />
            <KV label={txt('工作目录', 'CWD')} value={run.command.cwd} />
            <KV label={txt('超时', 'Timeout')} value={txt(run.command.timeoutSec + ' 秒', run.command.timeoutSec + ' s')} />
            <KV label={txt('输入文件', 'Input File')} value={run.command.inputFile} />
            <KV label={txt('完整 argv', 'Argv')} value={JSON.stringify(run.command.argv)} />
            <KV label={txt('环境变量（附加）', 'Env (+)')} value={JSON.stringify(run.command.env)} />
          </div>
          <div className="mt-3">
            <div className="label mb-1">{txt('命令行（可复制到终端重现）', 'Command Line')}</div>
            <Pre>
              {run.command.argv
                .map((p) => (/[\s"]/.test(p) ? JSON.stringify(p) : p))
                .join(' ')}
            </Pre>
          </div>
        </Section>
      )}

      {run.aiResultJson && (
        <Section title={txt('2. 分析结果', '2. Analysis')} defaultOpen>
          <div className="text-base mb-2">{run.aiResultJson.summary}</div>
          {run.aiResultJson.details && (
            <div className="text-base text-ink-dim mb-2">
              <MarkdownText text={run.aiResultJson.details} />
            </div>
          )}
          {(run.aiResultJson.notify_title || run.aiResultJson.notify_body) && (
            <div className="card p-2.5 bg-warn/10 border-warn/30 text-base">
              <div className="font-medium text-warn">{run.aiResultJson.notify_title}</div>
              <div className="text-ink-dim mt-0.5">{run.aiResultJson.notify_body}</div>
            </div>
          )}
          <details className="mt-2">
            <summary className="text-base text-ink-faint cursor-pointer hover:text-ink-dim">
              {txt('原始 JSON 响应', 'Raw JSON response')}
            </summary>
            <Pre>{JSON.stringify(run.aiResultJson, null, 2)}</Pre>
          </details>
        </Section>
      )}

      {run.autoInstallAttempts && run.autoInstallAttempts.length > 0 && (
        <Section title={txt(`3. 依赖安装记录 (${run.autoInstallAttempts.length} 次)`, `3. Dependency Install Attempts (${run.autoInstallAttempts.length})`)} defaultOpen>
          <div className="space-y-3">
            {run.autoInstallAttempts.map((a, i) => (
              <div
                key={i}
                className={
                  'border rounded-md p-3.5 text-base ' +
                  (a.success
                    ? 'border-accent/40 bg-accent/5'
                    : 'border-danger/40 bg-danger/5')
                }
              >
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="font-medium font-mono">{a.missingModule}</span>
                  {a.suggestion?.package_name &&
                    a.suggestion.package_name !== a.missingModule && (
                      <span className="text-ink-faint">→ {a.suggestion.package_name}</span>
                    )}
                  {a.success ? (
                    <span className="tag bg-accent/20 text-accent">{txt('安装成功，重试成功', 'Install succeeded, retry succeeded')}</span>
                  ) : a.retried ? (
                    <span className="tag bg-warn/20 text-warn">{txt('已重试，仍未通过', 'Retried, still failed')}</span>
                  ) : (
                    <span className="tag bg-danger/20 text-danger">{txt('未执行重试', 'Retry not executed')}</span>
                  )}
                  {a.installExitCode !== undefined && (
                    <span className="text-ink-faint">pip exit {a.installExitCode}</span>
                  )}
                </div>

                {a.suggestion?.reasoning && (
                  <div className="text-ink-dim mb-1.5">{a.suggestion.reasoning}</div>
                )}

                {a.suggestion?.install_argv && <Pre>{a.suggestion.install_argv.join(' ')}</Pre>}

                {a.error && <div className="text-danger mt-2 font-mono break-all">{a.error}</div>}

                {a.installStderrTail && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-ink-faint hover:text-ink-dim">
                      {txt('pip stderr 末尾日志', 'pip stderr tail log')}
                    </summary>
                    <Pre className="text-warn mt-1">{a.installStderrTail}</Pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {run.aiError && (
        <Section title={txt('4. AI 错误', '4. AI Error')} defaultOpen>
          <div className="text-danger text-base font-mono whitespace-pre-wrap">{run.aiError}</div>
        </Section>
      )}

      <Section title={txt('5. 输入参数', '5. Input Args')}>
        <Pre>{JSON.stringify(run.inputArgs, null, 2)}</Pre>
      </Section>

      <Section title={txt('6. 脚本输出', '6. Script Output')}>
        {run.scriptOutputJson !== undefined && run.scriptOutputJson !== null ? (
          <Pre>{JSON.stringify(run.scriptOutputJson, null, 2)}</Pre>
        ) : (
          <Pre className="text-ink-faint italic">{run.stdoutExcerpt || txt('（无输出）', '(no output)')}</Pre>
        )}
      </Section>

      {run.stderrExcerpt && (
        <Section
          title={
            run.exitCode === 0
              ? txt('7. 运行日志(stderr)', '7. Runtime Log (stderr)')
              : txt('7. 错误输出', '7. stderr')
          }
        >
          <Pre className={run.exitCode === 0 ? 'text-ink-dim' : 'text-warn'}>
            {run.stderrExcerpt}
          </Pre>
        </Section>
      )}

      {run.renderedPrompt && (
        <Section title={txt('8. 渲染后的 Prompt', '8. Rendered Prompt')}>
          <Pre>{run.renderedPrompt}</Pre>
        </Section>
      )}

      <Section title={txt('9. 高级操作', '9. Advanced Actions')}>
        <div className="flex gap-2 flex-wrap">
          <button className="btn" onClick={onRetryAi} disabled={busy}>
            {busy ? '...' : txt('重新分析（AI）', 'Re-analyze (AI)')}
          </button>
        </div>
      </Section>
    </div>
  )
}

function stageColor(stage: Run['stage']) {
  return stage === 'running' ? 'accent' : stage === 'failed' ? 'danger' : 'ink'
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  const color =
    accent === 'accent' ? 'text-accent' : accent === 'danger' ? 'text-danger' : 'text-ink'
  return (
    <div className="panel-card p-3">
      <div className="label mb-1">{label}</div>
      <div className={'text-lg font-mono ' + color}>{value}</div>
    </div>
  )
}

function Section({
  title,
  children,
  defaultOpen = false
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="panel-card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3.5 h-11 hover:bg-bg-raised transition-colors"
      >
        <span className="text-sm font-semibold tracking-wide text-ink-dim">{title}</span>
        <span className="text-ink-faint text-lg leading-none">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="p-3 border-t border-line">{children}</div>}
    </div>
  )
}

function Pre({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={
        'text-base font-mono whitespace-pre-wrap break-all bg-bg p-3 rounded border border-line max-h-[400px] overflow-auto ' +
        className
      }
    >
      {children}
    </pre>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="text-ink-faint w-36 shrink-0">{label}</span>
      <span className="break-all flex-1">{value}</span>
    </div>
  )
}

function MarkdownText({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      nodes.push(
        <pre
          key={`code-${nodes.length}`}
          className="text-base font-mono whitespace-pre-wrap bg-bg p-3 rounded border border-line max-h-[320px] overflow-auto"
        >
          {codeLines.join('\n')}
        </pre>
      )
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      nodes.push(
        <ul key={`ul-${nodes.length}`} className="list-disc pl-5 space-y-1">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      )
      continue
    }
    if (/^#{1,3}\s+/.test(line)) {
      const title = line.replace(/^#{1,3}\s+/, '')
      nodes.push(
        <div key={`h-${nodes.length}`} className="font-semibold text-ink mt-2">
          {renderInlineMarkdown(title)}
        </div>
      )
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !/^\s*[-*]\s+/.test(lines[i])) {
      para.push(lines[i])
      i++
    }
    nodes.push(
      <p key={`p-${nodes.length}`} className="whitespace-pre-wrap leading-6">
        {renderInlineMarkdown(para.join('\n'))}
      </p>
    )
  }
  return <div className="space-y-2">{nodes}</div>
}

function renderInlineMarkdown(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const token = m[0]
    if (token.startsWith('`')) {
      out.push(
        <code key={`c-${m.index}`} className="font-mono px-1 py-0.5 rounded bg-bg border border-line text-sm">
          {token.slice(1, -1)}
        </code>
      )
    } else {
      out.push(
        <strong key={`b-${m.index}`} className="text-ink">
          {token.slice(2, -2)}
        </strong>
      )
    }
    last = regex.lastIndex
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
