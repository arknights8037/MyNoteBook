import { describe, expect, it } from 'vitest'

import { createDefaultExecutionPolicy } from '@/models/agent/executionPolicy'
import { createMcpRuntimeTools } from '@/models/integrations/mcp'
import { AGENT_TOOL_REGISTRY } from '@/services/agent/AgentToolRegistry'
import { compileCognitivePrompt, compileCognitiveRunSpec } from '@/services/cognitive/CognitiveRunCompiler'
import { getCognitiveMode, getKnowledgeControlTemplate } from '@/services/cognitive/CognitiveRegistry'

describe('CognitiveRunCompiler', () => {
  it('compiles tags to names while only tightening the base ExecutionPolicy', () => {
    const mode = getCognitiveMode('research')!
    const template = getKnowledgeControlTemplate(mode.defaultTemplateId!)
    const external = createMcpRuntimeTools([descriptor('read', true), descriptor('write', false)])
    const base = createDefaultExecutionPolicy({
      tokenBudget: 4096,
      allowedTools: ['get_current_document', 'search_documents', 'replace_block', 'mcp:*'],
    })
    const spec = compileCognitiveRunSpec({
      baseExecutionPolicy: base,
      mode,
      template,
      builtInTools: AGENT_TOOL_REGISTRY,
      externalTools: external.map((tool) => ({ name: tool.runtimeName, tags: tool.tags })),
    })

    expect(spec.executionPolicy.allowedTools).toEqual([
      'get_current_document',
      'search_documents',
      external[0]!.runtimeName,
    ])
    expect(spec.executionPolicy.allowedTools).not.toContain('replace_block')
    expect(spec.executionPolicy.allowedTools).not.toContain(external[1]!.runtimeName)
    expect(spec.executionPolicy.allowWriteProposals).toBe(false)
    expect(spec.executionPolicy.riskLevel).toBe('read_only')
  })

  it('orders safety, skill, mode, template, task, context and contract predictably', () => {
    const mode = getCognitiveMode('learning')!
    const spec = compileCognitiveRunSpec({
      baseExecutionPolicy: createDefaultExecutionPolicy({ tokenBudget: 1024, allowedTools: [] }),
      mode,
      template: getKnowledgeControlTemplate(mode.defaultTemplateId!),
      builtInTools: AGENT_TOOL_REGISTRY,
    })
    const prompt = compileCognitivePrompt({
      baseSafety: 'BASE',
      skillInstructions: 'SKILL',
      runSpec: spec,
      task: 'TASK',
      context: 'CONTEXT',
      outputContractInstruction: 'CONTRACT',
    })
    const positions = [
      'BASE',
      'SKILL',
      '当前使用 Learning',
      '先让用户解释或作答',
      'TASK',
      'CONTEXT',
      'CONTRACT',
    ].map((part) => prompt.indexOf(part))
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('binds Review to the shared read-only compiler and review contract', () => {
    const mode = getCognitiveMode('review')!
    const spec = compileCognitiveRunSpec({
      baseExecutionPolicy: createDefaultExecutionPolicy({
        tokenBudget: 2048,
        allowedTools: ['read_document', 'replace_block'],
      }),
      mode,
      template: getKnowledgeControlTemplate(mode.defaultTemplateId!),
      builtInTools: AGENT_TOOL_REGISTRY,
    })

    expect(spec.outputContractId).toBe('review-result')
    expect(spec.templateId).toBe('review-findings')
    expect(spec.executionPolicy.allowedTools).toEqual(['read_document'])
    expect(spec.executionPolicy.allowWriteProposals).toBe(false)
  })

  it('binds Learning to a read-only contract without formal write tools', () => {
    const mode = getCognitiveMode('learning')!
    const spec = compileCognitiveRunSpec({
      baseExecutionPolicy: createDefaultExecutionPolicy({
        tokenBudget: 2048,
        allowedTools: ['read_document', 'replace_block'],
      }),
      mode,
      template: getKnowledgeControlTemplate(mode.defaultTemplateId!),
      builtInTools: AGENT_TOOL_REGISTRY,
    })

    expect(spec.outputContractId).toBe('learning-turn')
    expect(spec.templateId).toBe('learning-coach')
    expect(spec.interactionPolicy.requireUserAttempt).toBe(true)
    expect(spec.executionPolicy.allowedTools).toEqual(['read_document'])
    expect(spec.executionPolicy.allowWriteProposals).toBe(false)
  })
})

function descriptor(name: string, readOnly: boolean) {
  return {
    serverId: 'server',
    serverName: 'Server',
    name,
    description: name,
    inputSchema: {},
    readOnly,
    serverTrusted: true,
  }
}
