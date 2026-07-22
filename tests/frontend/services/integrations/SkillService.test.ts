import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('SkillService', () => {
  beforeEach(() => {
    invoke.mockReset()
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {})
    globalThis.localStorage.clear()
  })

  it('injects only enabled Skill summaries and versions, leaving bodies on demand', async () => {
    invoke.mockImplementation(async (command: string, payload: { input: { skillId?: string } }) => {
      if (command === 'list_installed_skills') {
        return [
          {
            id: 'writer',
            description: 'Write clearly',
            enabled: true,
            valid: true,
            files: [{ name: 'SKILL.md', path: 'SKILL.md', kind: 'file' }],
          },
          { id: 'broken', description: 'Broken', enabled: true, valid: false },
          { id: 'off', description: 'Disabled', enabled: false, valid: true },
        ]
      }
      if (command === 'read_skill_file' && payload.input.skillId === 'writer') {
        return '# Writing workflow'
      }
      throw new Error('unexpected command')
    })

    const { loadEnabledSkillPrompt } = await import('@/services/integrations/SkillService')
    const prompt = await loadEnabledSkillPrompt()

    expect(prompt.catalog).toContain('writer: Write clearly')
    expect(prompt.catalog).not.toContain('broken')
    expect(prompt.instructions).toBe('')
    expect(prompt.skills).toEqual([{ id: 'writer', version: null }])
    expect(invoke).not.toHaveBeenCalledWith('read_skill_file', expect.anything())
  })

  it('can create a Skill disabled from its first persisted state', async () => {
    invoke.mockResolvedValue({ id: 'weekly-report', enabled: false })
    const { createSkill } = await import('@/services/integrations/SkillService')

    await createSkill('周报整理', '整理项目周报', false)

    expect(invoke).toHaveBeenCalledWith('create_skill', {
      input: expect.objectContaining({
        name: '周报整理',
        description: '整理项目周报',
        enabled: false,
      }),
    })
  })
})
