import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

describe('Runtime architecture boundaries', () => {
  it('keeps contracts and the AI SDK adapter independent from Vue and database adapters', () => {
    for (const file of [
      'packages/agent-runtime-contracts/src/index.ts',
      'packages/pi-agent-worker/src/PiAgentRuntimePrototype.ts',
      'packages/pi-agent-worker/src/PiToolAdapter.ts',
      'packages/pi-agent-worker/src/StdioPiToolRpcClient.ts',
      'packages/agent-runtime-worker/src/AgentWorkerHost.ts',
      'packages/agent-runtime-worker/src/AiSdkWorkerRuntime.ts',
      'packages/agent-runtime-worker/src/StdioAgentWorkerChannel.ts',
      'src/models/agent/agentRuntimeContract.ts',
      'src/services/agent/AgentRuntimeClient.ts',
      'src/services/ai/AiSdkAgentRuntime.ts',
      'src/infrastructure/runtime/TauriAgentRuntimeAdapter.ts',
    ]) {
      const source = readFileSync(resolve(root, file), 'utf8')
      expect(source, file).not.toMatch(
        /from ['"]vue['"]|@tauri-apps\/plugin-sql|@\/infrastructure\/|\bsqlite\b|\bsqlx\b/i,
      )
    }
  })

  it('keeps the Phase 3 worker host independent from PI and application infrastructure', () => {
    for (const file of [
      'packages/agent-runtime-worker/src/AgentWorkerHost.ts',
      'packages/agent-runtime-worker/src/AiSdkWorkerRuntime.ts',
      'packages/agent-runtime-worker/src/main.ts',
      'packages/agent-runtime-worker/src/StdioAgentWorkerChannel.ts',
    ]) {
      const source = readFileSync(resolve(root, file), 'utf8')
      expect(source, file).not.toMatch(
        /pi-agent|@tauri-apps|@\/|plugin-sql|\bsqlite\b|\bsqlx\b|from ['"]vue['"]/i,
      )
    }
  })

  it('makes the PI worker consume the frozen manifest without defining another registry', () => {
    const source = readFileSync(
      resolve(root, 'packages/pi-agent-worker/src/PiToolAdapter.ts'),
      'utf8',
    )
    expect(source).toContain('manifest.map')
    expect(source).not.toMatch(/AGENT_TOOL_REGISTRY|buildDomainToolManifest|getAgentToolJsonSchema/)
  })

  it('does not add a new WebView SQL writer outside the reviewed baseline', () => {
    const actual = listSourceFiles(resolve(root, 'src/infrastructure/database'))
      .filter((file) => readFileSync(file, 'utf8').includes('.execute('))
      .map((file) => relative(root, resolve(root, file)).replaceAll('\\', '/'))
      .sort()
    expect(actual).toEqual(
      [
        'src/infrastructure/database/agent/AgentWorkspaceHistoryStore.ts',
        'src/infrastructure/database/agent/TauriAgentCommunicationRepository.ts',
        'src/infrastructure/database/agent/TauriAgentRepository.ts',
        'src/infrastructure/database/automation/TauriAutomationRepository.ts',
        'src/infrastructure/database/cognitive/TauriCognitiveSessionRepository.ts',
        'src/infrastructure/database/documents/TauriDocumentRepository.ts',
        'src/infrastructure/database/home/TauriInformationHomeRepository.ts',
        'src/infrastructure/database/inbox/TauriEmailRepository.ts',
        'src/infrastructure/database/inbox/TauriImRepository.ts',
        'src/infrastructure/database/inbox/TauriRssRepository.ts',
        'src/infrastructure/database/knowledge/TauriKnowledgeRepository.ts',
        'src/infrastructure/database/knowledge/TauriViewRepository.ts',
        'src/infrastructure/database/knowledge/TauriWorkRepository.ts',
        'src/infrastructure/database/shared/connection.ts',
        'src/infrastructure/database/workspace/TauriMindMapRepository.ts',
        'src/infrastructure/database/workspace/TauriWorkspaceViewRepository.ts',
      ].sort(),
    )
  })
})

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return listSourceFiles(path)
    return entry.isFile() && /\.(?:ts|vue)$/.test(entry.name) ? [path] : []
  })
}
