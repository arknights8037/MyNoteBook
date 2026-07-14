import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ok } from '@/models/result'

const createTask = vi.fn()
const createSkill = vi.fn()
const readSkillFile = vi.fn()
const writeSkillFile = vi.fn()
const setSkillEnabled = vi.fn()

vi.mock('@/infrastructure/database/automationRepositoryFactory', () => ({
  createAutomationRepository: async () => ({ createTask }),
}))

vi.mock('./SkillService', () => ({
  createSkill,
  readSkillFile,
  writeSkillFile,
  setSkillEnabled,
}))

describe('AgentResourceDraftService', () => {
  beforeEach(() => {
    createTask.mockReset()
    createSkill.mockReset()
    readSkillFile.mockReset()
    writeSkillFile.mockReset()
    setSkillEnabled.mockReset()
  })

  it('persists automations as disabled drafts without scheduling them', async () => {
    createTask.mockImplementation(async (input) =>
      ok({ ...input, updatedAt: input.createdAt, nextRunAt: null, lastRunAt: null }),
    )
    const { createAutomationDraft } = await import('./AgentResourceDraftService')

    await expect(
      createAutomationDraft(
        {
          name: '每日摘要',
          instruction: '整理今日变化',
          triggerType: 'daily',
          triggerConfig: { dailyTime: '18:30' },
          documentId: 'doc-1',
        },
        (prefix) => `${prefix}-1`,
      ),
    ).resolves.toEqual({
      created: true,
      id: 'automation-1',
      name: '每日摘要',
      enabled: false,
    })
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'automation-1', enabled: false }),
    )
  })

  it('writes complete Skill instructions and leaves the new Skill disabled', async () => {
    createSkill.mockResolvedValue({ id: 'weekly-report', name: '周报整理', enabled: false })
    readSkillFile.mockResolvedValue(
      '---\nname: weekly-report\ndescription: 整理周报\n---\n\n# placeholder',
    )
    const { createSkillDraft } = await import('./AgentResourceDraftService')

    await expect(
      createSkillDraft({
        name: '周报整理',
        description: '整理周报',
        instructions: '## 触发条件\n\n仅在用户要求生成周报时触发。',
      }),
    ).resolves.toEqual({
      created: true,
      id: 'weekly-report',
      name: '周报整理',
      enabled: false,
    })
    expect(writeSkillFile).toHaveBeenCalledWith(
      'weekly-report',
      'SKILL.md',
      expect.stringContaining('# 周报整理\n\n## 触发条件'),
    )
    expect(createSkill).toHaveBeenCalledWith('周报整理', '整理周报', false)
    expect(setSkillEnabled).not.toHaveBeenCalled()
  })

  it('immediately disables drafts when connected to an older native runtime', async () => {
    createSkill.mockResolvedValue({ id: 'legacy-skill', name: '旧运行时 Skill', enabled: true })
    readSkillFile.mockResolvedValue('---\nname: legacy-skill\ndescription: test\n---\n')
    const { createSkillDraft } = await import('./AgentResourceDraftService')

    await createSkillDraft({
      name: '旧运行时 Skill',
      description: '兼容测试',
      instructions: '保持停用。',
    })

    expect(setSkillEnabled).toHaveBeenCalledWith('legacy-skill', false)
  })
})
