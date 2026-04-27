import { BrowserWindow, screen, app, shell, Menu } from 'electron'
import path from 'node:path'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { SettingsRepo } from './db'
import { paths } from './paths'
import { runtimeLog } from './logger'

let ballWin: BrowserWindow | null = null
let panelWin: BrowserWindow | null = null
let helpWin: BrowserWindow | null = null
let isQuitting = false

function quickCommandShell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]
    }
  }
  return { file: process.env['SHELL'] || 'sh', args: ['-lc', command] }
}

export function executeQuickCommand(command: string, cwd: string): void {
  if (!fs.existsSync(cwd)) {
    runtimeLog.warn('quick_command_invalid_cwd', { cwd, command })
    throw new Error(`命令执行目录不存在: ${cwd}`)
  }
  const logPath = path.join(paths().dataDir, 'quick-command.log')
  const startedAt = new Date().toISOString()
  fs.appendFileSync(logPath, `\n[${startedAt}] START\ncwd=${cwd}\ncmd=${command}\n`)
  runtimeLog.info('quick_command_start', { cwd, command })

  const shellCommand = quickCommandShell(command)
  fs.appendFileSync(logPath, `shell=${shellCommand.file} args=${JSON.stringify(shellCommand.args)}\n`)
  const child = spawn(shellCommand.file, shellCommand.args, {
    cwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let out = ''
  let err = ''
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString('utf8')
    if (out.length > 8000) out = out.slice(-8000)
  })
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString('utf8')
    if (err.length > 8000) err = err.slice(-8000)
  })
  child.on('close', (code) => {
    const endedAt = new Date().toISOString()
    fs.appendFileSync(
      logPath,
      `[${endedAt}] END code=${code ?? 'null'}\nstdout_tail:\n${out || '(empty)'}\nstderr_tail:\n${err || '(empty)'}\n`
    )
    runtimeLog.info('quick_command_end', { cwd, command, code: code ?? null })
  })
  child.on('error', (e) => {
    const endedAt = new Date().toISOString()
    fs.appendFileSync(logPath, `[${endedAt}] ERROR ${(e as Error).message}\n`)
    runtimeLog.error('quick_command_error', { cwd, command, error: (e as Error).message })
  })
}

export function markQuitting(): void {
  isQuitting = true
}

const PRELOAD = path.join(__dirname, '../preload/index.js')

function rendererUrl(page: 'panel' | 'ball' | 'help'): string {
  // electron-vite dev server
  if (process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}/${page}.html`
  }
  return path.join(__dirname, `../renderer/${page}.html`)
}

function loadInto(win: BrowserWindow, page: 'panel' | 'ball' | 'help'): void {
  const url = rendererUrl(page)
  if (url.startsWith('http')) {
    win.loadURL(url)
  } else {
    win.loadFile(url)
  }
}

export function createBallWindow(): BrowserWindow {
  if (ballWin && !ballWin.isDestroyed()) return ballWin

  const display = screen.getPrimaryDisplay()
  const { width, height } = display.workAreaSize
  const size = 64
  const margin = 24

  ballWin = new BrowserWindow({
    width: size,
    height: size,
    x: width - size - margin,
    y: height - size - margin,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: false
    }
  })

  ballWin.setAlwaysOnTop(true, 'floating')
  ballWin.webContents.on('context-menu', () => {
    const s = SettingsRepo.get()
    const projectRoot = process.cwd()
    const quickItems = (s.quickCommands ?? [])
      .map((x) => ({
        name: String(x.name ?? '').trim(),
        command: String(x.command ?? '').trim(),
        cwd: typeof x.cwd === 'string' && x.cwd.trim() ? x.cwd.trim() : projectRoot
      }))
      .filter((x) => x.name && x.command)

    const commandSubmenu =
      quickItems.length > 0
        ? quickItems.map((x) => ({
            label: x.name,
            click: () => executeQuickCommand(x.command, x.cwd)
          }))
        : [{ label: '暂无命令，请先在“快捷命令”中添加', enabled: false }]

    const menu = Menu.buildFromTemplate([
      {
        label: '帮助',
        click: () => showHelpWindow()
      },
      { type: 'separator' },
      {
        label: '添加快捷命令',
        click: () => showPanel()
      },
      {
        label: '命令菜单',
        submenu: commandSubmenu
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => app.quit()
      }
    ])
    menu.popup({ window: ballWin ?? undefined })
  })
  ballWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      ballWin?.hide()
    }
  })

  loadInto(ballWin, 'ball')
  return ballWin
}

export function createPanelWindow(): BrowserWindow {
  if (panelWin && !panelWin.isDestroyed()) return panelWin

  panelWin = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: false
    }
  })

  panelWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      panelWin?.hide()
    }
  })

  loadInto(panelWin, 'panel')
  return panelWin
}

export function togglePanel(): void {
  const w = createPanelWindow()
  if (w.isVisible()) w.hide()
  else {
    w.show()
    w.focus()
  }
}

export function hidePanel(): void {
  panelWin?.hide()
}

export function showPanel(): void {
  const w = createPanelWindow()
  w.show()
  w.focus()
}

export function isPanelMaximized(): boolean {
  if (!panelWin || panelWin.isDestroyed()) return false
  return panelWin.isMaximized()
}

export function togglePanelMaximize(): boolean {
  const w = createPanelWindow()
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
  return w.isMaximized()
}

export function showHelpWindow(): void {
  if (helpWin && !helpWin.isDestroyed()) {
    helpWin.show()
    helpWin.focus()
    return
  }
  helpWin = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: '帮助中心',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: false
    }
  })
  helpWin.on('closed', () => {
    helpWin = null
  })
  loadInto(helpWin, 'help')
  helpWin.once('ready-to-show', () => {
    helpWin?.show()
    helpWin?.focus()
  })
}

export function getBallBounds():
  | {
      x: number
      y: number
      width: number
      height: number
    }
  | null {
  if (!ballWin || ballWin.isDestroyed()) return null
  return ballWin.getBounds()
}

export function setBallPosition(x: number, y: number): void {
  if (!ballWin || ballWin.isDestroyed()) return
  ballWin.setPosition(Math.round(x), Math.round(y))
}

export function snapBallToEdge(): void {
  if (!ballWin || ballWin.isDestroyed()) return
  const bounds = ballWin.getBounds()
  const center = {
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2)
  }
  const display = screen.getDisplayNearestPoint(center)
  const work = display.workArea
  const threshold = 36
  const half = Math.floor(bounds.width / 2)

  let targetX = bounds.x
  let targetY = bounds.y

  const nearLeft = bounds.x <= work.x + threshold
  const nearRight = bounds.x + bounds.width >= work.x + work.width - threshold
  const nearTop = bounds.y <= work.y + threshold
  const nearBottom = bounds.y + bounds.height >= work.y + work.height - threshold

  if (nearLeft) targetX = work.x - half
  else if (nearRight) targetX = work.x + work.width - half

  if (nearTop) targetY = work.y - half
  else if (nearBottom) targetY = work.y + work.height - half

  ballWin.setPosition(Math.round(targetX), Math.round(targetY))
}

export function openPath(p: string): void {
  shell.openPath(p)
}

// Re-export for ipc usage
export { app }
