import { invoke } from '@tauri-apps/api/core'

import { loadAppSettings } from '@/models/settings/settings'
import { runCancellableAgentInvoke, throwIfAgentToolAborted } from '@/services/agent/AgentToolCancellation'

export async function executeRustAgentTool(
  name:
    | 'search_documents'
    | 'list_document_groups'
    | 'read_document'
    | 'find_blocks_by_regex'
    | 'replace_blocks_by_regex'
    | 'read_skill_file'
    | 'execute_shell'
    | 'inspect_environment_paths'
    | 'discover_local_tools'
    | 'get_system_info',
  args: Record<string, unknown>,
  callId?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (name === 'read_skill_file') {
    const skillId = typeof args.skillId === 'string' ? args.skillId : ''
    const relativePath = typeof args.relativePath === 'string' ? args.relativePath : ''
    throwIfAgentToolAborted(signal)
    return invoke<string>('read_skill_file', {
      input: {
        dataDirectory: loadAppSettings().dataDirectory,
        skillId,
        relativePath,
        requireEnabled: true,
      },
    })
  }
  const operation = () =>
    invoke<string>('execute_rig_tool', {
      input: {
        dataDirectory: loadAppSettings().dataDirectory,
        callId,
        name,
        argumentsJson: JSON.stringify(args),
      },
    })
  const output = await (callId ? runCancellableAgentInvoke(callId, signal, operation) : operation())
  return JSON.parse(output) as unknown
}
