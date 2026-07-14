import type {
  AutomationTask,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/models/automation'
import type { AppResult } from '@/models/result'
import type { InstalledSkill } from '@/models/skill'
import type { CreateAutomationCommand } from './AutomationService'

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

export interface AutomationDraftWriter {
  createTask(command: CreateAutomationCommand): Promise<AppResult<AutomationTask>>
}

export interface SkillDraftPort {
  create(name: string, description: string, enabled: boolean): Promise<InstalledSkill>
  setEnabled(skillId: string, enabled: boolean): Promise<void>
  readFile(skillId: string, relativePath: string): Promise<string>
  writeFile(skillId: string, relativePath: string, content: string): Promise<void>
}

export class AgentResourceDraftService {
  constructor(
    private readonly automations: AutomationDraftWriter,
    private readonly skills: SkillDraftPort,
  ) {}

  async createAutomationDraft(
    input: AutomationDraftInput,
  ): Promise<{ created: true; id: string; name: string; enabled: false }> {
    const result = await this.automations.createTask({ ...input, enabled: false })
    if (!result.ok) throw new Error(result.error.message)
    return { created: true, id: result.value.id, name: result.value.name, enabled: false }
  }

  async createSkillDraft(
    input: SkillDraftInput,
  ): Promise<{ created: true; id: string; name: string; enabled: false }> {
    const skill = await this.skills.create(input.name, input.description, false)
    if (skill.enabled !== false) await this.skills.setEnabled(skill.id, false)
    const generated = await this.skills.readFile(skill.id, 'SKILL.md')
    const frontmatter = extractFrontmatter(generated)
    await this.skills.writeFile(
      skill.id,
      'SKILL.md',
      `${frontmatter}\n\n${normalizeSkillInstructions(input.instructions, skill)}\n`,
    )
    return { created: true, id: skill.id, name: skill.name, enabled: false }
  }
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
