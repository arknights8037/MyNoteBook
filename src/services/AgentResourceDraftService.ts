import type {
  AutomationTask,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/models/automation'
import type { AppResult } from '@/models/result'
import type { McpServerConfig, McpTransport } from '@/models/mcp'
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

export interface McpServerDraftInput {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  cwd?: string
  url?: string
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

export interface McpDraftPort {
  list(): Promise<McpServerConfig[]>
  importText(content: string): Promise<McpServerConfig[]>
  setEnabled(serverId: string, enabled: boolean): Promise<McpServerConfig>
  setTrusted(serverId: string, trusted: boolean): Promise<McpServerConfig>
}

export class AgentResourceDraftService {
  constructor(
    private readonly automations: AutomationDraftWriter,
    private readonly skills: SkillDraftPort,
    private readonly mcp: McpDraftPort,
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

  async createMcpServerDraft(
    input: McpServerDraftInput,
  ): Promise<{ created: true; id: string; name: string; enabled: false; trusted: false }> {
    validateMcpDraft(input)
    const existing = await this.mcp.list()
    const id = createAvailableMcpId(input.name, new Set(existing.map((server) => server.id)))
    const definition =
      input.transport === 'stdio'
        ? {
            name: input.name.trim(),
            command: input.command!.trim(),
            args: input.args ?? [],
            ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
            enabled: false,
          }
        : { name: input.name.trim(), url: input.url!.trim(), enabled: false }
    const servers = await this.mcp.importText(JSON.stringify({ mcpServers: { [id]: definition } }))
    let server = servers.find((item) => item.id === id)
    if (!server) throw new Error('MCP 草稿已写入，但无法在配置列表中找到。')
    if (server.enabled) server = await this.mcp.setEnabled(id, false)
    if (server.trusted) server = await this.mcp.setTrusted(id, false)
    return { created: true, id: server.id, name: server.name, enabled: false, trusted: false }
  }
}

function validateMcpDraft(input: McpServerDraftInput): void {
  if (!input.name.trim()) throw new Error('MCP 服务名称不能为空。')
  if (input.transport === 'stdio' && !input.command?.trim()) {
    throw new Error('stdio MCP 必须提供启动命令。')
  }
  if (input.transport === 'http') {
    const value = input.url?.trim()
    if (!value) throw new Error('HTTP MCP 必须提供 URL。')
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('HTTP MCP URL 无效。')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('HTTP MCP URL 只支持 http 或 https。')
    }
  }
}

function createAvailableMcpId(name: string, existing: Set<string>): string {
  const normalized = name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const base = normalized || 'mcp-server'
  let id = base
  let suffix = 2
  while (existing.has(id)) id = `${base.slice(0, 75)}-${suffix++}`
  return id
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
