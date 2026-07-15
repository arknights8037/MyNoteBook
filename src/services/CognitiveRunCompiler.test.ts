import { describe, expect, it } from 'vitest'

import { createDefaultExecutionPolicy } from '@/models/executionPolicy'
import { createMcpRuntimeTools } from '@/models/mcp'
import { AGENT_TOOL_REGISTRY } from './AgentToolRegistry'
import { compileCognitivePrompt, compileCognitiveRunSpec } from './CognitiveRunCompiler'
import { getCognitiveMode, getKnowledgeControlTemplate } from './CognitiveRegistry'

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
      '未经用户明确确认',
      'TASK',
      'CONTEXT',
      'CONTRACT',
    ].map((part) => prompt.indexOf(part))
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
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
