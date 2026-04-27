import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 在 dev 模式下把数据和 tasks 放到项目根目录（方便调试），
 * 在打包后用 Electron 的 userData 目录。
 */
export function paths() {
  const isDev = !app.isPackaged
  const root = isDev ? process.cwd() : app.getPath('userData')

  const dataDir = path.join(root, 'data')
  const runsDir = path.join(dataDir, 'runs')
  const tasksDir = path.join(root, 'tasks')
  const dbPath = path.join(dataDir, 'app.db')

  for (const d of [dataDir, runsDir, tasksDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  }

  return { root, dataDir, runsDir, tasksDir, dbPath }
}
