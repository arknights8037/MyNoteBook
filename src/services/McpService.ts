import { invoke } from '@tauri-apps/api/core'

import { getDefaultDataDirectory } from '@/infrastructure/database/dataDirectory'
import type { McpResourceDescriptor, McpServerConfig, McpToolDescriptor } from '@/models/mcp'
import { loadAppSettings } from '@/models/settings'
import { runCancellableAgentInvoke } from './AgentToolCancellation'

async function dataDirectory(): Promise<string> {
  return loadAppSettings().dataDirectory ?? getDefaultDataDirectory()
}

export async function listMcpServers(): Promise<McpServerConfig[]> {
  return invoke('list_mcp_servers', { input: { dataDirectory: await dataDirectory() } })
}

export async function importMcpConfig(sourcePath: string): Promise<McpServerConfig[]> {
  return invoke('import_mcp_config', {
    input: { dataDirectory: await dataDirectory(), sourcePath },
  })
}

export async function importMcpConfigText(content: string): Promise<McpServerConfig[]> {
  return invoke('import_mcp_config_text', {
    input: { dataDirectory: await dataDirectory(), content },
  })
}

export async function setMcpServerEnabled(
  serverId: string,
  enabled: boolean,
): Promise<McpServerConfig> {
  return invoke('set_mcp_server_enabled', {
    input: { dataDirectory: await dataDirectory(), serverId, enabled },
  })
}

export async function setMcpServerTrusted(
  serverId: string,
  trusted: boolean,
): Promise<McpServerConfig> {
  return invoke('set_mcp_server_trusted', {
    input: { dataDirectory: await dataDirectory(), serverId, trusted },
  })
}

export async function removeMcpServer(serverId: string): Promise<void> {
  return invoke('remove_mcp_server', {
    input: { dataDirectory: await dataDirectory(), serverId },
  })
}

export async function listMcpTools(serverId?: string): Promise<McpToolDescriptor[]> {
  return invoke('list_mcp_tools', {
    input: { dataDirectory: await dataDirectory(), ...(serverId ? { serverId } : {}) },
  })
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  options?: { callId?: string; signal?: AbortSignal },
): Promise<unknown> {
  const operation = async () =>
    invoke('call_mcp_tool', {
      input: {
        dataDirectory: await dataDirectory(),
        callId: options?.callId,
        serverId,
        toolName,
        arguments: args,
      },
    })
  return options?.callId
    ? runCancellableAgentInvoke(options.callId, options.signal, operation)
    : operation()
}

export async function listMcpResources(serverId?: string): Promise<McpResourceDescriptor[]> {
  return invoke('list_mcp_resources', {
    input: { dataDirectory: await dataDirectory(), ...(serverId ? { serverId } : {}) },
  })
}

export async function readMcpResource(serverId: string, uri: string): Promise<unknown> {
  return invoke('read_mcp_resource', {
    input: { dataDirectory: await dataDirectory(), serverId, uri },
  })
}
