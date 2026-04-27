import { describe, expect, it } from 'vitest'
import { parseAiJson } from './ai'

describe('parseAiJson', () => {
  it('supports fenced json', () => {
    const res = parseAiJson(
      '```json\n{"summary":"ok","need_notify":true,"notify_title":"t","notify_body":"b"}\n```'
    )
    expect(res.summary).toBe('ok')
    expect(res.need_notify).toBe(true)
    expect(res.notify_title).toBe('t')
  })

  it('throws for mixed text json', () => {
    expect(() => parseAiJson('分析如下：{"summary":"done","need_notify":false} 结束')).toThrow(
      /JSON 解析失败/
    )
  })

  it('fills default summary when missing', () => {
    const res = parseAiJson('{"need_notify": false}')
    expect(res.summary).toBe('AI 未提供摘要')
  })

  it('throws for invalid json without object', () => {
    expect(() => parseAiJson('not-json')).toThrow(/JSON 解析失败/)
  })

  it('checks run_id when provided', () => {
    const res = parseAiJson('{"run_id":"r1","summary":"ok","need_notify":false}', 'r1')
    expect(res.summary).toBe('ok')
    expect(() => parseAiJson('{"summary":"ok","need_notify":false}', 'r1')).toThrow(/缺少 run_id/)
    expect(() =>
      parseAiJson('{"run_id":"r2","summary":"ok","need_notify":false}', 'r1')
    ).toThrow(/run_id 不匹配/)
  })
})
