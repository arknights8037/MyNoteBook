import { createAutomationRepository } from '@/infrastructure/database/automationRepositoryFactory'
import { AgentResourceDraftService } from '@/services/AgentResourceDraftService'
import { AutomationService } from '@/services/AutomationService'
import {
  importMcpConfigText,
  listMcpServers,
  setMcpServerEnabled,
  setMcpServerTrusted,
} from '@/services/McpService'
import {
  createSkill,
  readSkillFile,
  setSkillEnabled,
  writeSkillFile,
} from '@/services/SkillService'

export async function createAgentResourceDraftService(
  createId: (prefix: string) => string,
): Promise<AgentResourceDraftService> {
  const automations = new AutomationService(await createAutomationRepository(), createId)
  return new AgentResourceDraftService(
    automations,
    {
      create: createSkill,
      setEnabled: setSkillEnabled,
      readFile: readSkillFile,
      writeFile: writeSkillFile,
    },
    {
      list: listMcpServers,
      importText: importMcpConfigText,
      setEnabled: setMcpServerEnabled,
      setTrusted: setMcpServerTrusted,
    },
  )
}
