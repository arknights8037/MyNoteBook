import { invoke } from '@tauri-apps/api/core'

import { loadAppSettings } from '@/models/settings'

export async function executeRustAgentTool(
  name: 'search_documents' | 'read_document',
  args: Record<string, unknown>,
): Promise<unknown> {
  const output = await invoke<string>('execute_rig_tool', {
    input: {
      dataDirectory: loadAppSettings().dataDirectory,
      name,
      argumentsJson: JSON.stringify(args),
    },
  })
  return JSON.parse(output) as unknown
}
