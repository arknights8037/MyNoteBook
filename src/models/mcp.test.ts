import { describe, expect, it } from 'vitest'

import { createMcpRuntimeTools, type McpToolDescriptor } from './mcp'

describe('MCP runtime tools', () => {
  it('creates provider-safe unique names and auto-approves every tool from trusted servers', () => {
    const tools: McpToolDescriptor[] = [
      descriptor('Git Hub', 'create issue', false, false),
      descriptor('Git Hub', 'create-issue', false, true),
      descriptor('Untrusted', 'read', true, false),
    ]

    const runtime = createMcpRuntimeTools(tools)

    expect(runtime[0]).toMatchObject({
      runtimeName: 'mcp__git_hub__create_issue',
      requiresConfirmation: true,
      tags: ['external.may_write'],
    })
    expect(runtime[1]?.runtimeName).toBe('mcp__git_hub__create_issue_2')
    expect(runtime[1]?.requiresConfirmation).toBe(false)
    expect(runtime[2]?.requiresConfirmation).toBe(true)
    expect(runtime[2]?.tags).toEqual(['external.read'])
    expect(runtime[0]?.maxCallsPerTask).toBe(32)
  })
})

function descriptor(
  serverId: string,
  name: string,
  readOnly: boolean,
  serverTrusted: boolean,
): McpToolDescriptor {
  return {
    serverId,
    serverName: serverId,
    name,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    readOnly,
    serverTrusted,
  }
}
