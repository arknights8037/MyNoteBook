import type { CognitiveModeId } from '@/models/cognitive'
import type { ExecutionPolicy } from '@/models/executionPolicy'
import type { AgentExternalTool } from '@/models/mcp'
import { AGENT_TOOL_REGISTRY } from './AgentToolRegistry'
import type { AgentOutputContract } from './AgentOutputContract'
import { compileCognitivePrompt, compileCognitiveRunSpec } from './CognitiveRunCompiler'
import {
  getAgentOutputContract,
  getCognitiveMode,
  getKnowledgeControlTemplate,
} from './CognitiveRegistry'

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
