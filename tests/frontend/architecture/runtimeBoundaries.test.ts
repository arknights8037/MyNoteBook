import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AGENT_TOOL_REGISTRY } from '@/services/agent/AgentToolRegistry'

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

  it('keeps the sidecar planner in the pure domain layer and out of Vue/Tauri persistence', () => {
    for (const [file, symbol] of [
      ['packages/agent-runtime-worker/src/SidecarRunPlanner.ts', 'planSidecarRun'],
      ['packages/agent-runtime-worker/src/SidecarRunFinalizer.ts', 'finalizeSidecarRun'],
    ]) {
      const source = readFileSync(resolve(root, file), 'utf8')
      expect(source).toContain(symbol)
      expect(source).not.toMatch(
        /from ['"]vue['"]|@tauri-apps|@\/infrastructure\/|plugin-sql|\bsqlite\b|\bsqlx\b/i,
      )
    }
  })

  it('makes the production composition default to the sidecar planner', () => {
    const composition = readFileSync(
      resolve(root, 'src/app/composition/workspaceServiceProviders.ts'),
      'utf8',
    )
    const run = readFileSync(resolve(root, 'src/composables/useAgentRun.ts'), 'utf8')
    expect(composition).toContain(
      "VITE_AGENT_RUNTIME_OWNER === 'webview' ? 'webview' : 'rust_worker'",
    )
    expect(run).toContain('adapter.startSubmission')
    expect(run).toContain('AgentSidecarSubmissionV1')
    expect(run).toContain('projectPersistedSidecarFinalization')
    expect(run).toContain("!sidecarOwned && mode === 'agent' && options.services?.mcpClient")
  })

  it('keeps A2A orchestration and cognitive terminal ownership in Rust', () => {
    const watcher = readFileSync(resolve(root, 'src-tauri/src/agent_request_watcher.rs'), 'utf8')
    const workspace = readFileSync(
      resolve(root, 'src/features/workspace/components/WorkspaceSurface.vue'),
      'utf8',
    )
    const legacyWorker = readFileSync(
      resolve(root, 'src/features/workspace/components/home/useAgentCommunicationWorker.ts'),
      'utf8',
    )
    expect(watcher).toContain('dispatch_next_background_request')
    expect(watcher).toContain('process_background_decision')
    expect(watcher).toContain('persist_research_candidates')
    expect(workspace).toContain("runtimeOwner === 'rust_worker'")
    expect(workspace).toContain('backgroundOwned:')
    expect(legacyWorker).toContain('if (options.backgroundOwned) return')
  })

  it('makes the PI worker consume the frozen manifest without defining another registry', () => {
    const source = readFileSync(
      resolve(root, 'packages/pi-agent-worker/src/PiToolAdapter.ts'),
      'utf8',
    )
    expect(source).toContain('manifest.map')
    expect(source).not.toMatch(/AGENT_TOOL_REGISTRY|buildDomainToolManifest|getAgentToolJsonSchema/)
  })

  it('keeps all production SQLite writes out of the WebView', () => {
    const actual = listSourceFiles(resolve(root, 'src'))
      .filter((file) => readFileSync(file, 'utf8').match(/\.execute\s*\(/))
      .map((file) => relative(root, resolve(root, file)).replaceAll('\\', '/'))
      .sort()
    expect(actual).toEqual([])

    const connection = readFileSync(
      resolve(root, 'src/infrastructure/database/shared/connection.ts'),
      'utf8',
    )
    const rustCatalog = readFileSync(resolve(root, 'src-tauri/src/database_mutations.rs'), 'utf8')
    const rustQueries = readFileSync(resolve(root, 'src-tauri/src/database_queries.rs'), 'utf8')
    const rustDatabase = readFileSync(resolve(root, 'src-tauri/src/database.rs'), 'utf8')
    const capability = readFileSync(resolve(root, 'src-tauri/capabilities/default.json'), 'utf8')
    expect(connection).toContain("invoke<SqlExecuteResult>('execute_database_mutation'")
    expect(connection).toContain("invoke<T[]>('execute_database_query'")
    expect(connection).not.toContain('database.execute')
    expect(connection).not.toContain('@tauri-apps/plugin-sql')
    expect(rustCatalog).toContain('pub enum DatabaseMutation')
    expect(rustCatalog).not.toContain('pub statement: String')
    expect(rustQueries).toContain('execute_database_query')
    expect(rustDatabase).toContain('.read_only(true)')
    expect(capability).not.toMatch(/"sql:/)
  })

  it('keeps TypeScript mutation IDs, production calls, and the Rust catalog in lockstep', () => {
    const typeSource = readFileSync(resolve(root, 'src/repositories/shared/SqlClient.ts'), 'utf8')
    const typeBlock = typeSource.match(
      /export type DatabaseMutation =([\s\S]*?)export interface SqlClient/,
    )?.[1]
    expect(typeBlock).toBeTruthy()
    const declared = [...typeBlock!.matchAll(/'([^']+)'/g)].map((match) => match[1]!).sort()

    const rustSource = readFileSync(resolve(root, 'src-tauri/src/database_mutations.rs'), 'utf8')
    const rustBlock = rustSource.match(/pub enum DatabaseMutation \{([\s\S]*?)\n\}/)?.[1]
    expect(rustBlock).toBeTruthy()
    const rustIds = [...rustBlock!.matchAll(/^\s+([A-Z][A-Za-z0-9]+),$/gm)]
      .map((match) => lowerFirst(match[1]!))
      .sort()

    const used = [
      ...new Set(
        listSourceFiles(resolve(root, 'src')).flatMap((file) =>
          [...readFileSync(file, 'utf8').matchAll(/\.mutate\(\s*['"]([^'"]+)['"]/g)].map(
            (match) => match[1]!,
          ),
        ),
      ),
    ].sort()

    expect(rustIds).toEqual(declared)
    expect(used).toEqual(declared)
  })

  it('routes every non-proposal built-in tool through the worker or Rust dispatcher', () => {
    const worker = readFileSync(
      resolve(root, 'packages/agent-runtime-worker/src/AiSdkWorkerRuntime.ts'),
      'utf8',
    )
    const dispatcher = readFileSync(
      resolve(root, 'src-tauri/src/agent_worker_supervisor.rs'),
      'utf8',
    )
    for (const tool of AGENT_TOOL_REGISTRY) {
      if (tool.risk === 'write') continue
      const owner = ['request_authorizer_input', 'report_progress'].includes(tool.name)
        ? worker
        : dispatcher
      expect(owner, `${tool.name} is not owned by the Phase 3 runtime`).toMatch(
        new RegExp(`['"]${tool.name}['"]`),
      )
    }
    expect(dispatcher).not.toContain('尚未迁移到 Rust Worker dispatcher')
  })

  it('keeps Provider network and credentials behind the Rust proxy boundary', () => {
    const contracts = readFileSync(
      resolve(root, 'packages/agent-runtime-contracts/src/index.ts'),
      'utf8',
    )
    const host = readFileSync(
      resolve(root, 'packages/agent-runtime-worker/src/AgentWorkerHost.ts'),
      'utf8',
    )
    const runtime = readFileSync(
      resolve(root, 'packages/agent-runtime-worker/src/AiSdkWorkerRuntime.ts'),
      'utf8',
    )
    const supervisor = readFileSync(
      resolve(root, 'src-tauri/src/agent_worker_supervisor.rs'),
      'utf8',
    )
    expect(contracts).not.toContain('credential.request')
    expect(host).toContain('provider.request')
    expect(runtime).toContain('proxyProviderFetch')
    expect(runtime).toContain('fetch: providerFetch')
    expect(supervisor).toContain('start_ai_request')
    expect(supervisor).toContain('inject_provider_credential')
  })
})

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return listSourceFiles(path)
    return entry.isFile() && /\.(?:ts|vue)$/.test(entry.name) ? [path] : []
  })
}

function lowerFirst(value: string): string {
  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`
}
