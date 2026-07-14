import { describe, expect, it } from 'vitest'

import { createMcpRuntimeTools, type McpToolDescriptor } from './mcp'

describe('MCP runtime tools', () => {
  it('creates provider-safe unique names and protects non-read-only tools', () => {
    const tools: McpToolDescriptor[] = [
      descriptor('Git Hub', 'create issue', false, false),
      descriptor('Git Hub', 'create-issue', true, true),
      descriptor('Untrusted', 'read', true, false),
    ]

    const runtime = createMcpRuntimeTools(tools)

    expect(runtime[0]).toMatchObject({
      runtimeName: 'mcp__git_hub__create_issue',
      requiresConfirmation: true,
    })
    expect(runtime[1]?.runtimeName).toBe('mcp__git_hub__create_issue_2')
    expect(runtime[1]?.requiresConfirmation).toBe(false)
    expect(runtime[2]?.requiresConfirmation).toBe(true)
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
