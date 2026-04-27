import { useEffect, useMemo, useState } from 'react'
import { api, unwrap } from '../api'
import { useStore } from '../store'
import type { RemoteScriptItem } from '@shared/types'

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '-'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}

function formatTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '-'
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}

export function ScriptLibrary() {
  const { txt, setToast, setTab, editTask, setNewTaskScriptPath } = useStore()
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [downloadingName, setDownloadingName] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<RemoteScriptItem[]>([])

  const loadList = async () => {
    setLoading(true)
    try {
      setItems(await unwrap(api.scripts.serverList()))
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadList()
  }, [])

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((x) => {
      return x.fileName.toLowerCase().includes(q) || x.summary.toLowerCase().includes(q)
    })
  }, [items, query])

  const handleUpload = async () => {
    setUploading(true)
    try {
      const local = await unwrap(api.scripts.upload())
      if (!local) return
      const overwrite = window.confirm(
        txt('如服务器存在同名脚本，是否覆盖？', 'Overwrite remote script if file name already exists?')
      )
      const result = await unwrap(api.scripts.serverUpload({ scriptPath: local.fileName, overwrite }))
      setToast(
        result.summary
          ? txt(`脚本已上传，简介：${result.summary}`, `Script uploaded. Summary: ${result.summary}`)
          : txt(`脚本已上传：${result.fileName}`, `Script uploaded: ${result.fileName}`)
      )
      await loadList()
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const handleDownload = async (fileName: string) => {
    setDownloadingName(fileName)
    try {
      const overwrite = window.confirm(
        txt('如本地存在同名脚本，是否覆盖？', 'Overwrite local script if file name already exists?')
      )
      const result = await unwrap(api.scripts.serverDownload({ fileName, overwrite }))
      setToast(txt(`脚本已下载：${result.fileName}`, `Script downloaded: ${result.fileName}`))
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setDownloadingName(null)
    }
  }

  const handleDownloadAndCreate = async (fileName: string) => {
    setDownloadingName(fileName)
    try {
      const overwrite = window.confirm(
        txt('如本地存在同名脚本，是否覆盖？', 'Overwrite local script if file name already exists?')
      )
      const result = await unwrap(api.scripts.serverDownload({ fileName, overwrite }))
      setNewTaskScriptPath(result.fileName)
      setTab('tasks')
      editTask('new')
      setToast(
        txt(
          `已下载并进入新建任务：${result.fileName}`,
          `Downloaded and opened new task: ${result.fileName}`
        )
      )
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setDownloadingName(null)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto page-shell">
      <div className="page-header">
        <div>
          <h2 className="text-lg font-bold">{txt('脚本库', 'Script Library')}</h2>
          <div className="text-xs text-ink-faint mt-0.5">
            {txt('统一管理脚本上传与下载，上传后服务端自动生成简介。', 'Manage script upload and download. Server generates a summary after upload.')}
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={loadList} disabled={loading || uploading}>
            {loading ? txt('刷新中...', 'Refreshing...') : txt('刷新列表', 'Refresh')}
          </button>
          <button className="btn btn-primary" onClick={handleUpload} disabled={uploading || loading}>
            {uploading ? txt('上传中...', 'Uploading...') : txt('上传脚本', 'Upload Script')}
          </button>
        </div>
      </div>

      <div className="panel-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            className="input flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={txt('搜索脚本名称或简介', 'Search by script name or summary')}
          />
          <div className="text-xs text-ink-faint">{txt(`共 ${visibleItems.length} 条`, `${visibleItems.length} items`)}</div>
        </div>
        {loading ? (
          <div className="empty-state py-10">{txt('正在加载脚本列表...', 'Loading scripts...')}</div>
        ) : visibleItems.length === 0 ? (
          <div className="empty-state py-10">{txt('暂无脚本，请先上传。', 'No scripts available. Upload one first.')}</div>
        ) : (
          <div className="space-y-2">
            {visibleItems.map((item) => (
              <div key={item.fileName} className="interactive-card p-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm truncate">{item.fileName}</div>
                  <div className="text-sm text-ink-dim mt-1 line-clamp-2">{item.summary || txt('暂无简介', 'No summary')}</div>
                  <div className="text-xs text-ink-faint mt-1">
                    {formatSize(item.size)} · {formatTime(item.updatedAt)}
                  </div>
                </div>
                <button
                  className="btn"
                  onClick={() => handleDownload(item.fileName)}
                  disabled={downloadingName !== null}
                >
                  {downloadingName === item.fileName
                    ? txt('下载中...', 'Downloading...')
                    : txt('下载', 'Download')}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => handleDownloadAndCreate(item.fileName)}
                  disabled={downloadingName !== null}
                >
                  {downloadingName === item.fileName
                    ? txt('处理中...', 'Processing...')
                    : txt('下载并创建任务', 'Download & New Task')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
