import { z } from 'zod'

import type { CognitiveModeDefinition, KnowledgeControlTemplate } from '@/models/cognitive'
import type { AgentOutputContract } from './AgentOutputContract'

const testContractSchema = z.object({
  summary: z.string().min(1),
  items: z.array(z.object({ kind: z.string().min(1), text: z.string().min(1) })).default([]),
})

export const COGNITIVE_TEST_OUTPUT_CONTRACT: AgentOutputContract<
  z.infer<typeof testContractSchema>
> = {
  id: 'cognitive-test',
  version: 1,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'items'],
    properties: {
      summary: { type: 'string', minLength: 1 },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'text'],
          properties: { kind: { type: 'string' }, text: { type: 'string' } },
        },
      },
    },
  },
  systemInstruction:
    '最终只输出符合 cognitive-test v1 的 JSON：summary 为摘要，items 为 kind/text 条目；不要输出 command 或 Patch。',
  validate: (value) => testContractSchema.parse(value),
}

export const COGNITIVE_MODES: readonly CognitiveModeDefinition[] = [
  createMode('research', 'Research', false, [
    'document.read',
    'knowledge.read',
    'knowledge.validate',
    'external.read',
    'system.inspect',
    'cognition.interact',
  ]),
  createMode('review', 'Review', false, [
    'document.read',
    'knowledge.read',
    'knowledge.validate',
    'external.read',
    'cognition.interact',
  ]),
  createMode('learning', 'Learning', false, [
    'document.read',
    'knowledge.read',
    'cognition.interact',
  ]),
]

export const KNOWLEDGE_CONTROL_TEMPLATES: readonly KnowledgeControlTemplate[] = [
  {
    id: 'default-cognitive-control',
    name: 'Default Cognitive Control',
    applicableModes: ['learning', 'research', 'review'],
    extractionRules: [],
    validationRules: [],
    conflictRules: [],
    approvalPolicy: { requireExplicitUserApproval: true },
    promptFragments: ['模型输出只是临时结果；未经用户明确确认，不得成为正式知识。'],
    version: 1,
    enabled: true,
  },
]

export function getCognitiveMode(id: string): CognitiveModeDefinition | null {
  return COGNITIVE_MODES.find((mode) => mode.id === id && mode.enabled) ?? null
}

export function getKnowledgeControlTemplate(id: string): KnowledgeControlTemplate | null {
  return (
    KNOWLEDGE_CONTROL_TEMPLATES.find((template) => template.id === id && template.enabled) ?? null
  )
}

export function getAgentOutputContract(id: string): AgentOutputContract<unknown> | null {
  return id === COGNITIVE_TEST_OUTPUT_CONTRACT.id ? COGNITIVE_TEST_OUTPUT_CONTRACT : null
}

function createMode(
  id: CognitiveModeDefinition['id'],
  name: string,
  allowWriteProposals: boolean,
  allowedToolTags: CognitiveModeDefinition['allowedToolTags'],
): CognitiveModeDefinition {
  return {
    id,
    name,
    description: `${name} cognitive policy`,
    interactionPolicy: {
      allowUserInput: true,
      allowWriteProposals,
      ...(id === 'learning' ? { requireUserAttempt: true } : {}),
    },
    contextPolicy: {
      includeCurrentDocument: true,
      includeSelection: true,
      includeEffectiveKnowledge: true,
      includeSessionState: true,
      maxSourceDocuments: id === 'learning' ? 4 : 12,
    },
    outputContractId: COGNITIVE_TEST_OUTPUT_CONTRACT.id,
    allowedToolTags,
    deniedToolTags: ['document.propose_write', 'knowledge.propose_write', 'external.may_write'],
    defaultSkillIds: [],
    defaultTemplateId: 'default-cognitive-control',
    systemInstructionFragments: [`当前使用 ${name} 认知策略。`],
    version: 1,
    enabled: true,
  }
}
