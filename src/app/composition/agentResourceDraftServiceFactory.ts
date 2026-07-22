import { createAutomationRepository } from '@/infrastructure/database/automation/automationRepositoryFactory'
import { AgentResourceDraftService } from '@/services/agent/AgentResourceDraftService'
import { AutomationService } from '@/services/automation/AutomationService'
import type { McpClientPort } from '@/services/ports/McpClientPort'
import {
  createSkill,
  readSkillFile,
  setSkillEnabled,
  writeSkillFile,
} from '@/services/integrations/SkillService'

export async function createAgentResourceDraftService(
  createId: (prefix: string) => string,
  mcpClient: McpClientPort,
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
      list: () => mcpClient.listServers(),
      importText: (content) => mcpClient.importConfigText(content),
      setEnabled: (serverId, enabled) => mcpClient.setServerEnabled(serverId, enabled),
      setTrusted: (serverId, trusted) => mcpClient.setServerTrusted(serverId, trusted),
    },
  )
}
