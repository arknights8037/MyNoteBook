import { describe, expect, it } from 'vitest'

import {
  AGENT_MAX_TASK_DURATION_MS,
  AGENT_MAX_TOOL_FAILURES,
  AGENT_MAX_TOOL_ROUNDS,
  AGENT_TOOL_REGISTRY,
  getAgentToolDefinition,
  isAllowedAgentTool,
} from './AgentToolRegistry'

describe('AgentToolRegistry', () => {
  it('only exposes the P0 allowlist and keeps writes confirmation-gated', () => {
    expect(AGENT_TOOL_REGISTRY).toHaveLength(21)
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

  it('defines bounded execution limits before a tool loop is enabled', () => {
    expect(AGENT_MAX_TOOL_ROUNDS).toBe(32)
    expect(AGENT_MAX_TOOL_FAILURES).toBe(6)
    expect(AGENT_MAX_TASK_DURATION_MS).toBe(10 * 60 * 1000)
  })
})
