import type { DomainToolManifestEntry } from '@/models/agent/agentRuntimeContract'
import type { AgentExternalTool } from '@/models/integrations/mcp'
import { AGENT_TOOL_REGISTRY } from '@/services/agent/AgentToolRegistry'
import { getAgentToolJsonSchema } from '@/services/agent/AgentToolSchemas'

/**
 * Produces the serializable, run-frozen tool catalog consumed by Runtime adapters.
 * AI SDK Zod schemas remain the executable validator in Phase 1; catalog parity tests
 * prevent names or policy metadata from drifting until schemas move fully into the catalog.
 */
export function buildDomainToolManifest(
  externalTools: readonly AgentExternalTool[] = [],
): DomainToolManifestEntry[] {
  return [
    ...AGENT_TOOL_REGISTRY.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: getAgentToolJsonSchema(tool.name),
      risk: tool.risk,
      executionAuthorization: tool.executionAuthorization,
      mutationApproval: tool.mutationApproval,
      externalActionApproval: tool.externalActionApproval,
      maxCallsPerRun: tool.maxCallsPerRun,
      tags: [...tool.tags],
      presentation: { ...tool.presentation },
      source: { kind: 'builtin' as const },
    })),
    ...externalTools.map((tool) => ({
      name: tool.runtimeName,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
      risk: tool.readOnly ? ('read' as const) : ('draft' as const),
      executionAuthorization: tool.executionAuthorization,
      mutationApproval: tool.mutationApproval,
      externalActionApproval: tool.externalActionApproval,
      maxCallsPerRun: tool.maxCallsPerRun,
      tags: [...tool.tags],
      presentation: { ...tool.presentation },
      source: {
        kind: 'mcp' as const,
        serverId: tool.serverId,
        serverName: tool.serverName,
        toolName: tool.name,
        readOnly: tool.readOnly,
        serverTrusted: tool.serverTrusted,
      },
    })),
  ]
}
