import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, getDefaultDataDirectory, loadAppSettings } = vi.hoisted(() => ({
  invoke: vi.fn(),
  getDefaultDataDirectory: vi.fn(),
  loadAppSettings: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/infrastructure/database/dataDirectory', () => ({ getDefaultDataDirectory }))
vi.mock('@/models/settings', () => ({ loadAppSettings }))

import { importMcpConfigText, listMcpServers } from './McpService'

describe('McpService', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
    getDefaultDataDirectory.mockReset()
    getDefaultDataDirectory.mockResolvedValue('C:\\app-data')
    loadAppSettings.mockReset()
  })

  it('resolves the default directory before invoking MCP commands', async () => {
    loadAppSettings.mockReturnValue({ dataDirectory: null })

    await listMcpServers()

    expect(invoke).toHaveBeenCalledWith('list_mcp_servers', {
      input: { dataDirectory: 'C:\\app-data' },
    })
  })

  it('uses the configured directory without requesting the default', async () => {
    loadAppSettings.mockReturnValue({ dataDirectory: 'D:\\notebook' })

    await listMcpServers()

    expect(getDefaultDataDirectory).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('list_mcp_servers', {
      input: { dataDirectory: 'D:\\notebook' },
    })
  })

  it('imports pasted JSON content through the text command', async () => {
    loadAppSettings.mockReturnValue({ dataDirectory: 'D:\\notebook' })
    const content = '{"mcpServers":{"local":{"command":"node"}}}'

    await importMcpConfigText(content)

    expect(invoke).toHaveBeenCalledWith('import_mcp_config_text', {
      input: { dataDirectory: 'D:\\notebook', content },
    })
  })
})
