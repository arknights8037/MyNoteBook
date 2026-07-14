import { invoke } from '@tauri-apps/api/core'

import type { McpResourceDescriptor, McpServerConfig, McpToolDescriptor } from '@/models/mcp'
import { loadAppSettings } from '@/models/settings'

function dataDirectory(): string {
  return loadAppSettings().dataDirectory
}

export function listMcpServers(): Promise<McpServerConfig[]> {
  return invoke('list_mcp_servers', { input: { dataDirectory: dataDirectory() } })
}

export function importMcpConfig(sourcePath: string): Promise<McpServerConfig[]> {
  return invoke('import_mcp_config', {
    input: { dataDirectory: dataDirectory(), sourcePath },
  })
}

export function setMcpServerEnabled(serverId: string, enabled: boolean): Promise<McpServerConfig> {
  return invoke('set_mcp_server_enabled', {
    input: { dataDirectory: dataDirectory(), serverId, enabled },
  })
}

export function setMcpServerTrusted(serverId: string, trusted: boolean): Promise<McpServerConfig> {
  return invoke('set_mcp_server_trusted', {
    input: { dataDirectory: dataDirectory(), serverId, trusted },
  })
}

export function removeMcpServer(serverId: string): Promise<void> {
  return invoke('remove_mcp_server', {
    input: { dataDirectory: dataDirectory(), serverId },
  })
}

export function listMcpTools(serverId?: string): Promise<McpToolDescriptor[]> {
  return invoke('list_mcp_tools', {
    input: { dataDirectory: dataDirectory(), ...(serverId ? { serverId } : {}) },
  })
}

export function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return invoke('call_mcp_tool', {
    input: {
      dataDirectory: dataDirectory(),
      serverId,
      toolName,
      arguments: args,
    },
  })
}

export function listMcpResources(serverId?: string): Promise<McpResourceDescriptor[]> {
  return invoke('list_mcp_resources', {
    input: { dataDirectory: dataDirectory(), ...(serverId ? { serverId } : {}) },
  })
}

export function readMcpResource(serverId: string, uri: string): Promise<unknown> {
  return invoke('read_mcp_resource', {
    input: { dataDirectory: dataDirectory(), serverId, uri },
  })
}
