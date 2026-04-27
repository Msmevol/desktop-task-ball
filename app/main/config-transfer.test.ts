import { describe, expect, it } from 'vitest'
import { buildImportPlan } from './config-transfer'

describe('buildImportPlan', () => {
  it('normalizes valid tasks and settings', () => {
    const plan = buildImportPlan({
      tasks: [
        {
          name: 'scan',
          tag: '监控',
          scriptPath: 'scan.py',
          argsSchema: {},
          timeoutSec: '120',
          retryCount: '2',
          retryDelaySec: 10,
          systemPrompt: 'sys',
          userPromptTemplate: 'usr',
          notifyEnabled: true
        }
      ],
      settings: {
        pythonPath: 'py',
        opencodePort: '4098',
        autoInstallEnabled: false
      }
    })
    expect(plan.tasks).toHaveLength(1)
    expect(plan.tasks[0].timeoutSec).toBe(120)
    expect(plan.tasks[0].retryCount).toBe(2)
    expect(plan.tasks[0].tag).toBe('监控')
    expect(plan.settings.pythonPath).toBe('py')
    expect(plan.settings.opencodePort).toBe(4098)
    expect(plan.settings.autoInstallEnabled).toBe(false)
  })

  it('skips invalid tasks and returns warnings', () => {
    const plan = buildImportPlan({
      tasks: [{ name: 'x' }, { scriptPath: 'a.py' }]
    })
    expect(plan.tasks).toHaveLength(0)
    expect(plan.skipped).toBe(2)
    expect(plan.warnings[0]).toContain('已跳过 2 条无效任务')
  })

  it('allows missing prompts when AI is disabled', () => {
    const plan = buildImportPlan({
      tasks: [
        {
          name: 'monitor-only',
          scriptPath: 'monitor.py',
          aiEnabled: false
        }
      ]
    })
    expect(plan.tasks).toHaveLength(1)
    expect(plan.tasks[0].aiEnabled).toBe(false)
    expect(plan.tasks[0].systemPrompt.length).toBeGreaterThan(0)
    expect(plan.tasks[0].userPromptTemplate.length).toBeGreaterThan(0)
  })
})
