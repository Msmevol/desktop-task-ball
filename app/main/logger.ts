import fs from 'node:fs'
import path from 'node:path'
import { paths } from './paths'

type Level = 'INFO' | 'WARN' | 'ERROR'
const MAX_BYTES = 2 * 1024 * 1024
const KEEP_FILES = 3

function safeString(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function line(level: Level, message: string, extra?: unknown): string {
  const ts = new Date().toISOString()
  const suffix = extra === undefined ? '' : ` ${safeString(extra)}`
  return `[${ts}] [${level}] ${message}${suffix}\n`
}

function append(level: Level, message: string, extra?: unknown): void {
  try {
    const file = path.join(paths().dataDir, 'runtime.log')
    rotateIfNeeded(file)
    fs.appendFileSync(file, line(level, message, extra), 'utf8')
  } catch {
    // never crash app due to logging failure
  }
}

function rotateIfNeeded(file: string): void {
  try {
    const stat = fs.existsSync(file) ? fs.statSync(file) : null
    if (!stat || stat.size < MAX_BYTES) return
    for (let i = KEEP_FILES; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`
      const dst = `${file}.${i}`
      if (fs.existsSync(src)) {
        try {
          fs.renameSync(src, dst)
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

export const runtimeLog = {
  info(message: string, extra?: unknown): void {
    append('INFO', message, extra)
  },
  warn(message: string, extra?: unknown): void {
    append('WARN', message, extra)
  },
  error(message: string, extra?: unknown): void {
    append('ERROR', message, extra)
  }
}
