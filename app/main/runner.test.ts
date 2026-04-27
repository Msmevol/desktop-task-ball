import { describe, expect, it } from 'vitest'
import { argsToCliFlags, detectScriptKind } from './runner'

describe('argsToCliFlags', () => {
  it('supports boolean flag without value', () => {
    const flags = argsToCliFlags(
      {
        headless: true,
        verbose: false
      },
      {
        headless: { type: 'boolean' },
        verbose: { type: 'boolean' }
      }
    )
    expect(flags).toEqual(['--headless'])
  })

  it('keeps key-value args for non-boolean types', () => {
    const flags = argsToCliFlags(
      {
        query: 'abc',
        limit: 10
      },
      {
        query: { type: 'string' },
        limit: { type: 'number' }
      }
    )
    expect(flags).toEqual(['--query', 'abc', '--limit', '10'])
  })
})

describe('detectScriptKind', () => {
  it('supports py/bat/cmd/ps1 scripts', () => {
    expect(detectScriptKind('a.py')).toBe('python')
    expect(detectScriptKind('a.bat')).toBe('batch')
    expect(detectScriptKind('a.cmd')).toBe('batch')
    expect(detectScriptKind('a.ps1')).toBe('powershell')
  })

  it('returns null for unsupported extension', () => {
    expect(detectScriptKind('a.sh')).toBeNull()
  })
})
