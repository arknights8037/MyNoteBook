import type { AgentToolTag } from '@/models/cognitive/cognitive'
import type {
  AgentAuthorizationRequirement,
  AgentToolPresentationMetadata,
} from '@/models/agent/agentTool'

export type McpTransport = 'stdio' | 'http'

export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransport
  enabled: boolean
  trusted: boolean
  command?: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  url?: string
  headers: Record<string, string>
  timeoutSeconds?: number
}

export interface McpToolDescriptor {
  serverId: string
  serverName: string
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
  serverTrusted: boolean
}

export interface McpResourceDescriptor {
  serverId: string
  serverName: string
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
}

export interface McpServerExposureSettings {
  version: number
  tools: Record<string, boolean>
}

export interface AgentExternalTool extends McpToolDescriptor {
  runtimeName: string
  executionAuthorization: AgentAuthorizationRequirement
  mutationApproval: AgentAuthorizationRequirement
  externalActionApproval: AgentAuthorizationRequirement
  maxCallsPerRun: number
  tags: AgentToolTag[]
  presentation: AgentToolPresentationMetadata
}

export function createMcpRuntimeTools(tools: McpToolDescriptor[]): AgentExternalTool[] {
  const used = new Set<string>()
  return tools.map((tool) => {
    const base = `mcp__${safeToolName(tool.serverId)}__${safeToolName(tool.name)}`.slice(0, 110)
    let runtimeName = base
    let suffix = 2
    while (used.has(runtimeName)) runtimeName = `${base.slice(0, 106)}_${suffix++}`
    used.add(runtimeName)
    return {
      ...tool,
      runtimeName,
      executionAuthorization: tool.serverTrusted && tool.readOnly ? 'not_required' : 'required',
      mutationApproval: 'not_required',
      externalActionApproval: 'not_required',
      maxCallsPerRun: 32,
      tags: [tool.readOnly ? 'external.read' : 'external.may_write'],
      presentation: {
        label: tool.title?.trim() || tool.name,
        category: 'external',
      },
    }
  })
}

function safeToolName(value: string): string {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || 'tool'
}
