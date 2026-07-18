import { describe, expect, it } from 'vitest'

import { filterAgentSlashCommands, resolveAgentSlashCommand } from './agentSlashCommand'

describe('agent slash commands', () => {
  it('routes a plan command to agent mode and removes the command token', () => {
    expect(resolveAgentSlashCommand('/plan 发布新版本')).toMatchObject({
      command: { name: 'plan', mode: 'agent', intent: 'plan' },
      prompt: '发布新版本',
      originalPrompt: '/plan 发布新版本',
    })
  })

  it('uses a useful default prompt for a command without arguments', () => {
    expect(resolveAgentSlashCommand('/create')?.prompt).toContain('创建')
  })

  it('binds thin review commands to the same Review intent', () => {
    expect(
      ['find-assumptions', 'find-conflicts', 'extract-claims'].map(
        (name) => resolveAgentSlashCommand(`/${name}`)?.command.intent,
      ),
    ).toEqual(['review', 'review', 'review'])
  })

  it('binds learn to the multi-turn Learning intent', () => {
    expect(resolveAgentSlashCommand('/learn 事件循环')).toMatchObject({
      command: { mode: 'agent', intent: 'learning' },
      prompt: '事件循环',
    })
  })

  it('filters the menu only while the first slash token is being typed', () => {
    expect(filterAgentSlashCommands('/pla').map((command) => command.name)).toEqual(['plan'])
    expect(filterAgentSlashCommands('/plan 开始')).toEqual([])
    expect(resolveAgentSlashCommand('/unknown task')).toBeNull()
  })
})
