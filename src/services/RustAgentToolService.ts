import { invoke } from '@tauri-apps/api/core'

import { loadAppSettings } from '@/models/settings'

export async function executeRustAgentTool(
  name:
    | 'search_documents'
    | 'read_document'
    | 'read_skill_file'
    | 'execute_shell'
    | 'inspect_environment_paths'
    | 'discover_local_tools'
    | 'get_system_info',
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === 'read_skill_file') {
    const skillId = typeof args.skillId === 'string' ? args.skillId : ''
    const relativePath = typeof args.relativePath === 'string' ? args.relativePath : ''
    return invoke<string>('read_skill_file', {
      input: {
        dataDirectory: loadAppSettings().dataDirectory,
        skillId,
        relativePath,
        requireEnabled: true,
      },
    })
  }
  const output = await invoke<string>('execute_rig_tool', {
    input: {
      dataDirectory: loadAppSettings().dataDirectory,
      name,
      argumentsJson: JSON.stringify(args),
    },
  })
  return JSON.parse(output) as unknown
}
