import { describe, expect, it } from 'vitest'

import { createMcpRuntimeTools } from '@/models/integrations/mcp'
import { buildDomainToolManifest } from '@/services/agent/DomainToolManifest'
import { AGENT_TOOL_REGISTRY } from '@/services/agent/AgentToolRegistry'

describe('DomainToolManifest', () => {
  it('freezes one catalog entry per built-in and MCP tool', () => {
    const [external] = createMcpRuntimeTools([
      {
        serverId: 'trusted-server',
        serverName: 'Trusted Server',
        name: 'lookup',
        description: 'Read external data',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        readOnly: true,
        serverTrusted: true,
      },
    ])
    const manifest = buildDomainToolManifest(external ? [external] : [])

    expect(manifest).toHaveLength(AGENT_TOOL_REGISTRY.length + 1)
    expect(new Set(manifest.map((tool) => tool.name)).size).toBe(manifest.length)
    expect(manifest.at(-1)).toMatchObject({
      name: external?.runtimeName,
      executionAuthorization: 'not_required',
      inputSchema: { type: 'object' },
      source: { kind: 'mcp', serverId: 'trusted-server', readOnly: true },
    })
    for (const tool of manifest) {
      expect(tool.description.trim(), tool.name).not.toBe('')
      expect(tool.maxCallsPerRun, tool.name).toBeGreaterThan(0)
      expect(tool.inputSchema, tool.name).toHaveProperty('type')
    }
  })
})
