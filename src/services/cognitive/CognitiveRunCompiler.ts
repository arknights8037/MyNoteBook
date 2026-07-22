import type {
  AgentToolTag,
  CognitiveModeDefinition,
  CognitiveRunSpec,
  KnowledgeControlTemplate,
} from '@/models/cognitive/cognitive'
import type { ExecutionPolicy } from '@/models/agent/executionPolicy'
import type { AgentToolDefinition } from '@/models/agent/agentTool'

export interface TaggedRuntimeTool {
  name: string
  tags: AgentToolTag[]
}

export function compileCognitiveRunSpec(input: {
  baseExecutionPolicy: ExecutionPolicy
  mode: CognitiveModeDefinition
  template?: KnowledgeControlTemplate | null
  skillIds?: string[]
  builtInTools: readonly AgentToolDefinition[]
  externalTools?: readonly TaggedRuntimeTool[]
}): CognitiveRunSpec {
  const template = input.template ?? null
  if (template && !template.applicableModes.includes(input.mode.id)) {
    throw new Error(`模板 ${template.id} 不适用于 ${input.mode.id}。`)
  }
  const allowedTags = new Set(input.mode.allowedToolTags)
  const deniedTags = new Set(input.mode.deniedToolTags)
  const catalog: TaggedRuntimeTool[] = [
    ...input.builtInTools.map((tool) => ({ name: tool.name, tags: tool.tags })),
    ...(input.externalTools ?? []),
  ]
  const baseAllowed = new Set(input.baseExecutionPolicy.allowedTools)
  const allowedTools = catalog
    .filter(
      (tool) =>
        tool.tags.some((tag) => allowedTags.has(tag)) &&
        !tool.tags.some((tag) => deniedTags.has(tag)),
    )
    .filter(
      (tool) =>
        baseAllowed.has(tool.name) || (tool.name.startsWith('mcp__') && baseAllowed.has('mcp:*')),
    )
    .map((tool) => tool.name)

  return {
    modeId: input.mode.id,
    modeVersion: input.mode.version,
    templateId: template?.id ?? null,
    templateVersion: template?.version ?? null,
    skillIds: Array.from(new Set(input.skillIds ?? input.mode.defaultSkillIds)),
    interactionPolicy: { ...input.mode.interactionPolicy },
    contextPolicy: { ...input.mode.contextPolicy },
    executionPolicy: {
      ...input.baseExecutionPolicy,
      allowedTools,
      allowUserInput:
        input.baseExecutionPolicy.allowUserInput && input.mode.interactionPolicy.allowUserInput,
      allowWriteProposals:
        input.baseExecutionPolicy.allowWriteProposals &&
        input.mode.interactionPolicy.allowWriteProposals,
      riskLevel: input.mode.interactionPolicy.allowWriteProposals
        ? input.baseExecutionPolicy.riskLevel
        : 'read_only',
    },
    outputContractId: input.mode.outputContractId,
    promptFragments: [
      ...input.mode.systemInstructionFragments,
      ...(template?.promptFragments ?? []),
    ],
  }
}

export function compileCognitivePrompt(input: {
  baseSafety: string
  skillInstructions?: string
  runSpec: CognitiveRunSpec
  task: string
  context: string
  outputContractInstruction: string
}): string {
  return [
    input.baseSafety,
    input.skillInstructions ?? '',
    ...input.runSpec.promptFragments,
    input.task,
    input.context,
    input.outputContractInstruction,
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
}
