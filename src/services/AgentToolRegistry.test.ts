import { describe, expect, it } from 'vitest'

import {
  AGENT_MAX_TASK_DURATION_MS,
  AGENT_MAX_TOOL_FAILURES,
  AGENT_MAX_TOOL_ROUNDS,
  AGENT_TOOL_REGISTRY,
  getAgentToolDefinition,
  isAllowedAgentTool,
  MIN_AGENT_WRITE_OUTPUT_TOKENS,
  createDefaultAgentExecutionPolicy,
  resolveAgentOutputTokenLimit,
} from './AgentToolRegistry'

describe('AgentToolRegistry', () => {
  it('only exposes the P0 allowlist and keeps writes confirmation-gated', () => {
    expect(AGENT_TOOL_REGISTRY).toHaveLength(23)
    expect(getAgentToolDefinition('read_mind_map')).toMatchObject({
      risk: 'read',
      requiresConfirmation: false,
      tags: ['knowledge.read'],
    })
    expect(getAgentToolDefinition('read_skill_file')).toMatchObject({
      risk: 'read',
      requiresConfirmation: false,
      maxCallsPerTask: 16,
    })
    expect(getAgentToolDefinition('request_authorizer_input')).toMatchObject({
      risk: 'read',
      requiresConfirmation: false,
      maxCallsPerTask: 6,
    })
    expect(isAllowedAgentTool('execute_shell')).toBe(true)
    expect(getAgentToolDefinition('execute_shell')).toMatchObject({
      risk: 'read',
      requiresConfirmation: false,
      maxCallsPerTask: 8,
    })
    expect(getAgentToolDefinition('replace_block')).toMatchObject({
      risk: 'write',
      requiresConfirmation: true,
      tags: ['document.propose_write'],
    })
    expect(getAgentToolDefinition('replace_text_by_regex')).toMatchObject({
      risk: 'write',
      requiresConfirmation: true,
    })
    expect(getAgentToolDefinition('create_group')).toMatchObject({
      risk: 'write',
      requiresConfirmation: true,
    })
    expect(getAgentToolDefinition('submit_document_edits')).toMatchObject({
      risk: 'write',
      requiresConfirmation: true,
      maxCallsPerTask: 2,
    })
    expect(getAgentToolDefinition('create_automation_draft')).toMatchObject({
      risk: 'draft',
      requiresConfirmation: true,
      maxCallsPerTask: 2,
      tags: ['external.may_write'],
    })
    expect(getAgentToolDefinition('create_skill_draft')).toMatchObject({
      risk: 'draft',
      requiresConfirmation: true,
      maxCallsPerTask: 2,
    })
  })

  it('keeps every tool name and model description unique and non-empty', () => {
    expect(new Set(AGENT_TOOL_REGISTRY.map((tool) => tool.name)).size).toBe(
      AGENT_TOOL_REGISTRY.length,
    )
    for (const tool of AGENT_TOOL_REGISTRY) {
      expect(tool.description.trim().length, tool.name).toBeGreaterThan(12)
    }
  })

  it('defines bounded execution limits before a tool loop is enabled', () => {
    expect(AGENT_MAX_TOOL_ROUNDS).toBe(32)
    expect(AGENT_MAX_TOOL_FAILURES).toBe(6)
    expect(AGENT_MAX_TASK_DURATION_MS).toBe(10 * 60 * 1000)
  })

  it('reserves a large output budget for write proposals', () => {
    const policy = createDefaultAgentExecutionPolicy(2_048)
    expect(MIN_AGENT_WRITE_OUTPUT_TOKENS).toBe(16_384)
    expect(policy.tokenBudget).toBe(16_384)
    expect(resolveAgentOutputTokenLimit(2_048, policy)).toBe(16_384)
  })
})
