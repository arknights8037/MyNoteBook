import type { CognitiveModeId } from '@/models/cognitive/cognitive'
import type { ExecutionPolicy } from '@/models/agent/executionPolicy'
import type { AgentExternalTool } from '@/models/integrations/mcp'
import { AGENT_TOOL_REGISTRY } from '@/services/agent/AgentToolRegistry'
import type { AgentOutputContract } from '@/services/agent/AgentOutputContract'
import { compileCognitivePrompt, compileCognitiveRunSpec } from '@/services/cognitive/CognitiveRunCompiler'
import {
  getAgentOutputContract,
  getCognitiveMode,
  getKnowledgeControlTemplate,
} from '@/services/cognitive/CognitiveRegistry'

export function prepareCognitiveRun(input: {
  modeId: CognitiveModeId
  templateId?: string | null
  baseExecutionPolicy: ExecutionPolicy
  skillIds?: string[]
  externalTools?: AgentExternalTool[]
  baseSafety: string
  skillInstructions?: string
  task: string
  context: string
}): {
  spec: ReturnType<typeof compileCognitiveRunSpec>
  outputContract: AgentOutputContract<unknown>
  systemPrompt: string
} {
  const mode = getCognitiveMode(input.modeId)
  if (!mode) throw new Error(`Cognitive Mode ${input.modeId} 不存在或未启用。`)
  const templateId = input.templateId === undefined ? mode.defaultTemplateId : input.templateId
  const template = templateId ? getKnowledgeControlTemplate(templateId) : null
  if (templateId && !template)
    throw new Error(`Knowledge Control Template ${templateId} 不存在或未启用。`)
  const spec = compileCognitiveRunSpec({
    baseExecutionPolicy: input.baseExecutionPolicy,
    mode,
    template,
    skillIds: input.skillIds,
    builtInTools: AGENT_TOOL_REGISTRY,
    externalTools: input.externalTools?.map((tool) => ({
      name: tool.runtimeName,
      tags: tool.tags,
    })),
  })
  const outputContract = getAgentOutputContract(spec.outputContractId)
  if (!outputContract) throw new Error(`Agent Output Contract ${spec.outputContractId} 不存在。`)
  return {
    spec,
    outputContract,
    systemPrompt: compileCognitivePrompt({
      baseSafety: input.baseSafety,
      skillInstructions: input.skillInstructions,
      runSpec: spec,
      task: input.task,
      context: input.context,
      outputContractInstruction: outputContract.systemInstruction,
    }),
  }
}
