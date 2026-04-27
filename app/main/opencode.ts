import { spawn, ChildProcess, execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { once } from 'node:events'
import { paths } from './paths'
import type { OpencodeStatus } from '@shared/types'
import { runtimeLog } from './logger'

/**
 * opencode 作为主进程的子进程运行。负责：
 *  - 启动 (spawn)，解析 stdout 拿到监听端口
 *  - 健康检查
 *  - 崩溃后自动重启 (仅限于已经 ready 过的情况)
 *  - 退出时 kill 进程树 (Windows 用 taskkill，Unix 用信号)
 *
 * 对外:
 *   start()   启动；返回 baseUrl。已经在启动中会等待；已 ready 直接返回。
 *   stop()    停止
 *   restart() stop + start
 *   getStatus() 当前状态快照
 *   getRecentLog() stdout/stderr 最近 200 段
 *
 * 事件：
 *   'status'  状态变化，payload 是 OpencodeStatus
 */

const STARTUP_TIMEOUT_MS = 30_000
const RESTART_DELAY_MS = 2000
const DEFAULT_PORT = 4097

class OpencodeManager extends EventEmitter {
  private child: ChildProcess | null = null
  private status: OpencodeStatus = { state: 'stopped' }
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private logBuffer: string[] = []
  private readonly logMax = 200
  private desiredBinPath = 'opencode'
  private desiredPort = DEFAULT_PORT

  getStatus(): OpencodeStatus {
    return { ...this.status }
  }

  getRecentLog(): string {
    return this.logBuffer.join('')
  }

  async start(binPath = 'opencode', port = DEFAULT_PORT): Promise<string> {
    const effectivePort = this.normalizePort(port)
    this.desiredBinPath = binPath
    this.desiredPort = effectivePort
    if (this.status.state === 'ready' && this.status.baseUrl) {
      return this.status.baseUrl
    }
    if (this.status.state === 'starting') {
      await once(this, 'status')
      const latest = this.status
      if (latest.state === 'ready' && latest.baseUrl) {
        return latest.baseUrl
      }
      throw new Error(this.status.lastError || 'opencode 启动失败，请检查配置后重试')
    }

    this.setStatus({
      state: 'starting',
      startedAt: new Date().toISOString(),
      lastError: undefined,
      port: undefined,
      baseUrl: undefined,
      pid: undefined
    })
    this.logBuffer = []
    runtimeLog.info('opencode_start_begin', { binPath, port: effectivePort })

    // 启动前清理“残留 opencode 占用同端口”的常见场景。
    const cleaned = await this.cleanupResidualOnPort(effectivePort)
    if (cleaned > 0) {
      this.pushLog(
        `\n[cleanup] 已清理 ${cleaned} 个残留 opencode 进程（port=${effectivePort}）\n`
      )
      runtimeLog.warn('opencode_cleanup_residual', { port: effectivePort, cleaned })
    }

    const args = ['serve', '--port', String(effectivePort), '--hostname', '127.0.0.1']

    let child: ChildProcess
    try {
      child = spawn(binPath, args, {
        cwd: paths().dataDir,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Windows 上 opencode 常是 .cmd 批处理，shell=true 才能通过 PATH 找到
        shell: process.platform === 'win32'
      })
    } catch (e) {
      this.setStatus({ state: 'missing', lastError: (e as Error).message })
      throw new Error(
          `无法启动 opencode: ${(e as Error).message}\n` +
          `请确认 opencode 已安装并在 PATH 中，或在设置里指定可执行文件路径。`
      )
    }

    this.child = child

    let portFound: number | undefined
    let readyResolve!: (port: number) => void
    let readyReject!: (err: Error) => void
    const readyPromise = new Promise<number>((res, rej) => {
      readyResolve = res
      readyReject = rej
    })

    // 从启动日志里抠 http://host:port
    // 不同 opencode 版本打印文案不同，这里用宽松的正则
    const portRegex = /https?:\/\/[^\s]*?:(\d{2,5})/

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.pushLog(text)
      if (!portFound) {
        const m = text.match(portRegex)
        if (m) {
          portFound = parseInt(m[1], 10)
          readyResolve(portFound)
        }
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('error', (err) => {
      const msg = err.message.includes('ENOENT')
          ? `未找到 opencode 可执行文件: ${binPath}。请先安装 opencode (npm i -g opencode-ai)，或在设置中指定绝对路径。`
        : err.message
      this.setStatus({ state: 'missing', lastError: msg })
      runtimeLog.error('opencode_process_error', { msg, binPath, port: effectivePort })
      readyReject(new Error(msg))
    })

    child.on('exit', (code, signal) => {
      const msg = `opencode 进程已退出 (code=${code}, signal=${signal})`
      this.pushLog(`\n[exit] ${msg}\n`)
      const wasOurChild = this.child === child
      this.child = null

      if (this.stopping) {
        this.setStatus({ state: 'stopped' })
        return
      }
      this.setStatus({ state: 'crashed', lastError: msg })
      runtimeLog.warn('opencode_process_exit', { code: code ?? null, signal: signal ?? null })
      if (!portFound) {
        readyReject(
          new Error(msg + '\n最近日志:\n' + this.logBuffer.slice(-10).join(''))
        )
        return
      }
      // ready 之后的崩溃才自动拉起，避免"启动失败->重启->失败"死循环
      if (wasOurChild && this.status.startedAt) {
        if (this.restartTimer) clearTimeout(this.restartTimer)
        this.restartTimer = setTimeout(() => {
          this.start(this.desiredBinPath, this.desiredPort).catch(() => {
            // 失败已写入 status
          })
        }, RESTART_DELAY_MS)
      }
    })

    const timeoutHandle = setTimeout(() => {
      readyReject(
        new Error(
          `opencode 启动超时 (${STARTUP_TIMEOUT_MS}ms)。最近日志:\n` +
            this.logBuffer.slice(-20).join('')
        )
      )
    }, STARTUP_TIMEOUT_MS)

    let readyPort: number
    try {
      readyPort = await readyPromise
    } catch (e) {
      clearTimeout(timeoutHandle)
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      this.setStatus({ state: 'crashed', lastError: (e as Error).message })
      runtimeLog.error('opencode_start_failed', { error: (e as Error).message })
      throw e
    }
    clearTimeout(timeoutHandle)

    const baseUrl = `http://127.0.0.1:${readyPort}`

    // 拿到端口 ≠ HTTP 立即可用，做一次主动探测
    try {
      await this.healthCheck(baseUrl)
    } catch (e) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      const msg = `opencode 端口 ${readyPort} 已监听，但健康检查失败: ${(e as Error).message}`
      this.setStatus({ state: 'crashed', lastError: msg })
      throw new Error(msg)
    }

    this.setStatus({
      state: 'ready',
      port: readyPort,
      baseUrl,
      pid: child.pid,
      startedAt: this.status.startedAt,
      lastError: undefined
    })
    runtimeLog.info('opencode_ready', { baseUrl, port: readyPort, pid: child.pid ?? null })
    return baseUrl
  }

  private async healthCheck(baseUrl: string, attempts = 15): Promise<void> {
    let lastErr = ''
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(baseUrl + '/', { method: 'GET' })
        // 200/404/405 都算连通 (opencode 根路径不一定有内容)
        if (r.status < 500) return
        lastErr = `HTTP ${r.status}`
      } catch (e) {
        lastErr = (e as Error).message
      }
      await new Promise((res) => setTimeout(res, 300))
    }
    throw new Error(`${attempts} 次健康探测均失败，最后错误: ${lastErr}`)
  }

  async stop(): Promise<void> {
    runtimeLog.info('opencode_stop_begin')
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child || !child.pid) {
      this.setStatus({ state: 'stopped' })
      this.stopping = false
      runtimeLog.info('opencode_stop_no_child')
      return
    }

    if (process.platform === 'win32') {
      // shell=true 启动的子进程自己还有子进程，taskkill /t 才能连根拔
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => resolve())
      })
    } else {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      await new Promise((res) => setTimeout(res, 2000))
      if (this.child) {
        try {
          this.child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }
    this.child = null
    this.setStatus({ state: 'stopped' })
    this.stopping = false
    runtimeLog.info('opencode_stopped')
  }

  async restart(binPath = 'opencode', port = DEFAULT_PORT): Promise<string> {
    await this.stop()
    return this.start(binPath, port)
  }

  private setStatus(patch: Partial<OpencodeStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }

  private pushLog(text: string): void {
    this.logBuffer.push(text)
    while (this.logBuffer.length > this.logMax) this.logBuffer.shift()
  }

  private normalizePort(v: number | undefined): number {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
    return Math.floor(n)
  }

  private execFileText(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || '').toString().trim()))
          return
        }
        resolve(String(stdout || ''))
      })
    })
  }

  private async findListeningPids(port: number): Promise<number[]> {
    if (process.platform === 'win32') {
      const text = await this.execFileText('netstat', ['-ano', '-p', 'tcp'])
      const rows = text.split(/\r?\n/)
      const out = new Set<number>()
      for (const row of rows) {
        const line = row.trim().replace(/\s+/g, ' ')
        if (!line.includes(' LISTENING ')) continue
        if (!line.includes(`:${port} `)) continue
        const cols = line.split(' ')
        const pid = Number(cols[cols.length - 1])
        if (Number.isFinite(pid) && pid > 0) out.add(pid)
      }
      return Array.from(out)
    }
    try {
      const text = await this.execFileText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
      return Array.from(
        new Set(
          text
            .split(/\r?\n/)
            .map((x) => Number(x.trim()))
            .filter((x) => Number.isFinite(x) && x > 0)
        )
      )
    } catch {
      return []
    }
  }

  private async isOpencodeProcess(pid: number): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        const text = await this.execFileText('tasklist', [
          '/FI',
          `PID eq ${pid}`,
          '/FO',
          'CSV',
          '/NH'
        ])
        return text.toLowerCase().includes('opencode')
      }
      const text = await this.execFileText('ps', ['-p', String(pid), '-o', 'comm='])
      return text.toLowerCase().includes('opencode')
    } catch {
      return false
    }
  }

  private async killPidTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      await this.execFileText('taskkill', ['/pid', String(pid), '/t', '/f'])
      return
    }
    await this.execFileText('kill', ['-9', String(pid)])
  }

  private async cleanupResidualOnPort(port: number): Promise<number> {
    let cleaned = 0
    let pids: number[] = []
    try {
      pids = await this.findListeningPids(port)
    } catch {
      return 0
    }
    for (const pid of pids) {
      if (this.child?.pid && pid === this.child.pid) continue
      const isOpencode = await this.isOpencodeProcess(pid)
      if (!isOpencode) continue
      try {
        await this.killPidTree(pid)
        cleaned++
      } catch {
        // ignore and continue
      }
    }
    return cleaned
  }
}

export const opencode = new OpencodeManager()
