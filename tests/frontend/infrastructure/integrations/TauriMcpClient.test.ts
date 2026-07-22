import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TauriMcpClient } from '@/infrastructure/integrations/TauriMcpClient'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('TauriMcpClient', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
  })

  it('resolves the data directory before invoking MCP commands', async () => {
    const client = new TauriMcpClient(async () => 'C:\\app-data')

    await client.listServers()

    expect(invoke).toHaveBeenCalledWith('list_mcp_servers', {
      input: { dataDirectory: 'C:\\app-data' },
    })
  })

  it('imports pasted JSON content through the text command', async () => {
    const client = new TauriMcpClient(async () => 'D:\\notebook')
    const content = '{"mcpServers":{"local":{"command":"node"}}}'

    await client.importConfigText(content)

    expect(invoke).toHaveBeenCalledWith('import_mcp_config_text', {
      input: { dataDirectory: 'D:\\notebook', content },
    })
  })
})
