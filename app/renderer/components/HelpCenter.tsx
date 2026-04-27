import { useEffect, useState } from 'react'

type AppInfo = {
  name: string
  version: string
  electron: string
  node: string
  platform: string
}

type UpdateInfo = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  message: string
}

export function HelpCenter() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    window.api.app.getInfo().then((r: any) => {
      if (r?.ok) setInfo(r.data)
    })
  }, [])

  const checkUpdate = async () => {
    setChecking(true)
    try {
      const r = await window.api.app.checkUpdate()
      if (r?.ok) setUpdateInfo(r.data)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="h-screen bg-bg text-ink overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-5">
        <div className="card p-5">
          <h1 className="text-lg font-semibold mb-2">任务球帮助中心</h1>
          <p className="text-sm text-ink-dim">
            任务球是本地优先的任务自动化助手：用于管理任务、执行脚本、生成 AI 总结，并在需要时发送通知。
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card p-4 space-y-2">
            <div className="label">版本信息</div>
            <Row k="应用名" v={info?.name ?? '-'} />
            <Row k="版本" v={info?.version ?? '-'} />
            <Row k="Electron" v={info?.electron ?? '-'} />
            <Row k="Node.js" v={info?.node ?? '-'} />
            <Row k="平台" v={info?.platform ?? '-'} />
            <div className="pt-2 flex gap-2">
              <button className="btn btn-primary" onClick={checkUpdate} disabled={checking}>
                {checking ? '检查中...' : '检查更新'}
              </button>
              <button className="btn" onClick={() => window.api.app.openProjectReadme()}>
                打开项目文档
              </button>
            </div>
            {updateInfo && (
              <div className="text-xs text-ink-faint border border-line rounded p-2 bg-bg-raised">
                {updateInfo.message}
              </div>
            )}
          </div>

          <div className="card p-4 space-y-2">
            <div className="label">快速开始</div>
            <p className="text-sm text-ink-dim">1. 创建任务并上传脚本文件。</p>
            <p className="text-sm text-ink-dim">2. 在设置页校验 Python 路径与 opencode 状态。</p>
            <p className="text-sm text-ink-dim">3. 执行任务并查看运行结果、AI 分析与日志。</p>
            <p className="text-sm text-ink-dim">4. 通过小球右键菜单访问常用操作。</p>
          </div>
        </div>

        <div className="card p-4 space-y-2">
          <div className="label">常见问题</div>
          <Faq q="小球无法拖动怎么办？" a="请按住小球非中心区域进行拖拽；中心按钮用于切换面板显示。" />
          <Faq q="脚本提示缺少依赖怎么办？" a="系统会识别缺失依赖并给出安装建议；仅在你确认后才会执行安装与重试。" />
          <Faq q="AI 分析不可用怎么办？" a="请在设置页检查 opencode 状态，必要时先重启服务，再执行“重新分析”。" />
        </div>

        <div className="card p-4 space-y-2">
          <div className="label">设计参考</div>
          <p className="text-sm text-ink-dim">
            本帮助页的结构参考了启动器类产品常见模式：版本区、检查更新、快速上手、FAQ（如 Raycast / Flow Launcher）。
          </p>
          <div className="flex gap-2 flex-wrap">
            <a className="btn btn-ghost" href="https://manual.raycast.com/windows/settings">
              Raycast Settings
            </a>
            <a className="btn btn-ghost" href="https://github.com/Flow-Launcher/Flow.Launcher">
              Flow Launcher
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex text-sm">
      <div className="w-20 text-ink-faint">{k}</div>
      <div className="font-mono text-ink-dim">{v}</div>
    </div>
  )
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <details className="border border-line rounded-md p-2">
      <summary className="cursor-pointer text-sm">{q}</summary>
      <div className="text-sm text-ink-dim mt-2">{a}</div>
    </details>
  )
}
