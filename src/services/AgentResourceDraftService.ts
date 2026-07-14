import { createAutomationRepository } from '@/infrastructure/database/automationRepositoryFactory'
import type { AutomationTriggerConfig, AutomationTriggerType } from '@/models/automation'
import type { InstalledSkill } from '@/models/skill'
import { AutomationService } from './AutomationService'
import { createSkill, readSkillFile, setSkillEnabled, writeSkillFile } from './SkillService'

export interface AutomationDraftInput {
  name: string
  instruction: string
  triggerType: AutomationTriggerType
  triggerConfig: AutomationTriggerConfig
  documentId: string | null
}

export interface SkillDraftInput {
  name: string
  description: string
  instructions: string
}

export async function createAutomationDraft(
  input: AutomationDraftInput,
  createId: (prefix: string) => string,
): Promise<{ created: true; id: string; name: string; enabled: false }> {
  const service = new AutomationService(await createAutomationRepository(), createId)
  const result = await service.createTask({ ...input, enabled: false })
  if (!result.ok) throw new Error(result.error.message)
  return { created: true, id: result.value.id, name: result.value.name, enabled: false }
}

export async function createSkillDraft(
  input: SkillDraftInput,
): Promise<{ created: true; id: string; name: string; enabled: false }> {
  const skill = await createSkill(input.name, input.description, false)
  if (skill.enabled !== false) await setSkillEnabled(skill.id, false)
  const generated = await readSkillFile(skill.id, 'SKILL.md')
  const frontmatter = extractFrontmatter(generated)
  await writeSkillFile(
    skill.id,
    'SKILL.md',
    `${frontmatter}\n\n${normalizeSkillInstructions(input.instructions, skill)}\n`,
  )
  return { created: true, id: skill.id, name: skill.name, enabled: false }
}

function extractFrontmatter(value: string): string {
  const match = value.match(/^---\r?\n[\s\S]*?\r?\n---/)
  if (!match) throw new Error('新建 Skill 缺少有效 frontmatter。')
  return match[0]
}

function normalizeSkillInstructions(instructions: string, skill: InstalledSkill): string {
  const value = instructions.trim()
  if (!value) throw new Error('Skill 指令不能为空。')
  return /^#\s/m.test(value) ? value : `# ${skill.name}\n\n${value}`
}
