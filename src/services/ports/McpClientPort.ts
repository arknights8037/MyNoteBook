import type {
  McpResourceDescriptor,
  McpServerConfig,
  McpServerExposureSettings,
  McpToolDescriptor,
} from '@/models/integrations/mcp'

export interface McpClientPort {
  listServers(): Promise<McpServerConfig[]>
  importConfig(sourcePath: string): Promise<McpServerConfig[]>
  importConfigText(content: string): Promise<McpServerConfig[]>
  setServerEnabled(serverId: string, enabled: boolean): Promise<McpServerConfig>
  setServerTrusted(serverId: string, trusted: boolean): Promise<McpServerConfig>
  removeServer(serverId: string): Promise<void>
  listTools(serverId?: string): Promise<McpToolDescriptor[]>
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { callId?: string; signal?: AbortSignal },
  ): Promise<unknown>
  listResources(serverId?: string): Promise<McpResourceDescriptor[]>
  readResource(serverId: string, uri: string): Promise<unknown>
  getServerExposure(): Promise<McpServerExposureSettings>
  setServerToolExposure(toolName: string, enabled: boolean): Promise<McpServerExposureSettings>
}
