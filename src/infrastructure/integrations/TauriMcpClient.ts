import { invoke } from '@tauri-apps/api/core'

import type {
  McpResourceDescriptor,
  McpServerConfig,
  McpServerExposureSettings,
  McpToolDescriptor,
} from '@/models/integrations/mcp'
import { runCancellableAgentInvoke } from '@/services/agent/AgentToolCancellation'
import type { McpClientPort } from '@/services/ports/McpClientPort'

export class TauriMcpClient implements McpClientPort {
  constructor(private readonly resolveDataDirectory: () => Promise<string>) {}

  async listServers(): Promise<McpServerConfig[]> {
    return invoke('list_mcp_servers', { input: { dataDirectory: await this.dataDirectory() } })
  }

  async importConfig(sourcePath: string): Promise<McpServerConfig[]> {
    return invoke('import_mcp_config', {
      input: { dataDirectory: await this.dataDirectory(), sourcePath },
    })
  }

  async importConfigText(content: string): Promise<McpServerConfig[]> {
    return invoke('import_mcp_config_text', {
      input: { dataDirectory: await this.dataDirectory(), content },
    })
  }

  async setServerEnabled(serverId: string, enabled: boolean): Promise<McpServerConfig> {
    return invoke('set_mcp_server_enabled', {
      input: { dataDirectory: await this.dataDirectory(), serverId, enabled },
    })
  }

  async setServerTrusted(serverId: string, trusted: boolean): Promise<McpServerConfig> {
    return invoke('set_mcp_server_trusted', {
      input: { dataDirectory: await this.dataDirectory(), serverId, trusted },
    })
  }

  async removeServer(serverId: string): Promise<void> {
    return invoke('remove_mcp_server', {
      input: { dataDirectory: await this.dataDirectory(), serverId },
    })
  }

  async listTools(serverId?: string): Promise<McpToolDescriptor[]> {
    return invoke('list_mcp_tools', {
      input: { dataDirectory: await this.dataDirectory(), ...(serverId ? { serverId } : {}) },
    })
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { callId?: string; signal?: AbortSignal },
  ): Promise<unknown> {
    const operation = async () =>
      invoke('call_mcp_tool', {
        input: {
          dataDirectory: await this.dataDirectory(),
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

  async listResources(serverId?: string): Promise<McpResourceDescriptor[]> {
    return invoke('list_mcp_resources', {
      input: { dataDirectory: await this.dataDirectory(), ...(serverId ? { serverId } : {}) },
    })
  }

  async readResource(serverId: string, uri: string): Promise<unknown> {
    return invoke('read_mcp_resource', {
      input: { dataDirectory: await this.dataDirectory(), serverId, uri },
    })
  }

  async getServerExposure(): Promise<McpServerExposureSettings> {
    return invoke('get_mcp_server_exposure', {
      input: { dataDirectory: await this.dataDirectory() },
    })
  }

  async setServerToolExposure(
    toolName: string,
    enabled: boolean,
  ): Promise<McpServerExposureSettings> {
    return invoke('set_mcp_server_tool_exposure', {
      input: { dataDirectory: await this.dataDirectory(), toolName, enabled },
    })
  }

  private dataDirectory(): Promise<string> {
    return this.resolveDataDirectory()
  }
}
