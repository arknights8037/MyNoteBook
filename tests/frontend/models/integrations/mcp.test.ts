import { describe, expect, it } from 'vitest'

import { createMcpRuntimeTools, type McpToolDescriptor } from '@/models/integrations/mcp'

describe('MCP runtime tools', () => {
  it('only exempts trusted read-only tools from execution authorization', () => {
    const tools: McpToolDescriptor[] = [
      descriptor('Git Hub', 'create issue', false, false),
      descriptor('Git Hub', 'create-issue', false, true),
      descriptor('Untrusted', 'read', true, false),
      descriptor('Trusted', 'read', true, true),
    ]

    const runtime = createMcpRuntimeTools(tools)

    expect(runtime[0]).toMatchObject({
      runtimeName: 'mcp__git_hub__create_issue',
      executionAuthorization: 'required',
      tags: ['external.may_write'],
    })
    expect(runtime[1]?.runtimeName).toBe('mcp__git_hub__create_issue_2')
    expect(runtime[1]?.executionAuthorization).toBe('required')
    expect(runtime[2]?.executionAuthorization).toBe('required')
    expect(runtime[3]?.executionAuthorization).toBe('not_required')
    expect(runtime[2]?.tags).toEqual(['external.read'])
    expect(runtime[0]?.maxCallsPerRun).toBe(32)
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
