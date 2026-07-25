import type { AgentToolExecutionResult, AgentToolRequest, AgentToolExecutionContext } from '@/services/agent/AgentToolExecutor'
import type { AgentExternalTool } from '@/models/integrations/mcp'
import { normalizeDocumentTitle } from '@/models/documents/documentPresentation'
import type { AgentRunDocumentSnapshot, UseAgentRunOptions } from './types'
import type { AgentEditPlan } from './agentRunPreparation'

export interface ReadableDocument {
  documentId: string
  documentTitle: string
  expectedVersion: number
  blocks: Array<{ id: string; type: string; text: string; index: number }>
}

export interface ToolExecutorFactoryInput {
  snapshot: { document: AgentRunDocumentSnapshot; settings: UseAgentRunOptions['settings'] }
  editPlan: AgentEditPlan
  options: UseAgentRunOptions
  mcpRuntimeTools: AgentExternalTool[]
  taskApprovedMcpServerIds: Set<string>
  workspaceDocumentIds: Set<string>
  discoveredDocumentIds: Set<string>
  readableDocuments: Map<string, ReadableDocument>
  waitForAuthorizerInput: (
    request: { question: string; context: string; options: string[]; allowFreeText: boolean },
    task: AgentEditPlan['task'],
  ) => Promise<string>
  executeAgentTool: (
    request: AgentToolRequest,
    context: AgentToolExecutionContext,
  ) => Promise<AgentToolExecutionResult>
  executeRustAgentTool: (
    name: string,
    args: Record<string, unknown>,
    callId?: string,
    signal?: AbortSignal,
  ) => Promise<unknown>
  parseReadDocumentProvenance: (
    toolResult: unknown,
    documentId: string,
  ) => ReadableDocument | null
  prepareReadDocumentObservation: (rawResult: unknown) => unknown
}

export function createExecuteToolCallback(input: ToolExecutorFactoryInput) {
  const {
    snapshot,
    editPlan,
    options,
    mcpRuntimeTools,
    taskApprovedMcpServerIds,
    workspaceDocumentIds,
    discoveredDocumentIds,
    readableDocuments,
    waitForAuthorizerInput,
    executeAgentTool,
    executeRustAgentTool,
    parseReadDocumentProvenance,
    prepareReadDocumentObservation,
  } = input

  return async (request: AgentToolRequest): Promise<AgentToolExecutionResult> => {
    const externalTool = mcpRuntimeTools.find(
      (tool) => tool.runtimeName === request.name,
    )
    if (externalTool) {
      if (
        externalTool.requiresConfirmation &&
        !taskApprovedMcpServerIds.has(externalTool.serverId)
      ) {
        const answer = await waitForAuthorizerInput(
          {
            question: `允许调用 MCP 工具"${externalTool.title || externalTool.name}"吗？`,
            context: `外部服务：${externalTool.serverName}\n选择"允许本次任务"后，该服务在当前 Agent 任务中的后续调用将自动批准。\n参数：${JSON.stringify(request.arguments).slice(0, 1_000)}`,
            options: ['允许本次任务', '仅允许本次调用', '拒绝'],
            allowFreeText: false,
          },
          editPlan.task,
        )
        if (answer === '允许本次任务') {
          taskApprovedMcpServerIds.add(externalTool.serverId)
        } else if (answer !== '仅允许本次调用') {
          return { ok: false, error: '授权人拒绝了 MCP 工具调用。' }
        }
      }
      try {
        const mcpClient = options.services?.mcpClient
        if (!mcpClient) throw new Error('当前运行环境未提供 MCP Client。')
        return {
          ok: true,
          value: await mcpClient.callTool(
            externalTool.serverId,
            externalTool.name,
            request.arguments,
            { callId: request.callId!, signal: request.signal },
          ),
        }
      } catch (mcpError) {
        return {
          ok: false,
          error: mcpError instanceof Error ? mcpError.message : String(mcpError),
        }
      }
    }
    return executeAgentTool(request, {
      currentDocument: {
        id: snapshot.document.id,
        title: normalizeDocumentTitle(snapshot.document.title),
        revision: snapshot.document.revision,
        text: snapshot.document.text,
        markdown: snapshot.document.markdown || snapshot.document.text,
        blocks: snapshot.document.blocks,
      },
      selectedBlocks: editPlan.usesSelection ? editPlan.targetBlocks : [],
      workspaceRootIds: snapshot.workspace?.rootDocumentIds ?? [],
      workspaceDocumentIds: [...workspaceDocumentIds],
      onDocumentsDiscovered: (documentIds) => {
        for (const documentId of documentIds) discoveredDocumentIds.add(documentId)
      },
      canReadDocument: (documentId) => discoveredDocumentIds.has(documentId),
      searchDocuments: options.document.searchDocuments,
      readDocument: options.document.readDocument,
      listMindMaps: async () => {
        const provider = options.services?.getMindMapService
        if (!provider) throw new Error('当前运行环境未提供思维导图服务。')
        const result = await (await provider()).list()
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      readMindMap: async (mindMapId, query) => {
        const provider = options.services?.getMindMapService
        if (!provider) throw new Error('当前运行环境未提供思维导图服务。')
        const result = await (await provider()).readSubtree(mindMapId, query)
        if (!result.ok) {
          if (result.error.code === 'not-found') return null
          throw new Error(result.error.message)
        }
        return result.value
      },
      onDocumentRead: async (documentId, toolResult) => {
        const provenance = parseReadDocumentProvenance(toolResult, documentId)
        if (provenance) {
          const existing = readableDocuments.get(documentId)
          if (existing && existing.expectedVersion === provenance.expectedVersion) {
            const blocks = new Map(existing.blocks.map((block) => [block.id, block]))
            for (const block of provenance.blocks) blocks.set(block.id, block)
            readableDocuments.set(documentId, {
              ...existing,
              blocks: [...blocks.values()].sort(
                (left, right) => left.index - right.index,
              ),
            })
          } else {
            readableDocuments.set(documentId, provenance)
          }
          return
        }
        const [document, blocks] = await Promise.all([
          options.document.readDocument(documentId),
          options.document.listDocumentBlocks(documentId),
        ])
        if (!document) return
        readableDocuments.set(documentId, {
          documentId,
          documentTitle: normalizeDocumentTitle(document.title),
          expectedVersion: document.revision,
          blocks: blocks.map((block) => ({
            id: block.id,
            type: block.type,
            text: block.plainText,
            index: block.index,
          })),
        })
      },
      executeNativeTool: executeRustAgentTool,
      requestAuthorizerInput: (request) =>
        waitForAuthorizerInput(request, editPlan.task),
      createAutomationDraft: async (draftInput) => {
        const provider = options.services?.getAgentResourceDraftService
        if (!provider) throw new Error('当前运行环境未提供 Agent 资源草稿服务。')
        const service = await provider()
        return service.createAutomationDraft(draftInput)
      },
      createSkillDraft: async (draftInput) => {
        const provider = options.services?.getAgentResourceDraftService
        if (!provider) throw new Error('当前运行环境未提供 Agent 资源草稿服务。')
        const service = await provider()
        return service.createSkillDraft(draftInput)
      },
      createMcpServerDraft: async (draftInput) => {
        const provider = options.services?.getAgentResourceDraftService
        if (!provider) throw new Error('当前运行环境未提供 Agent 资源草稿服务。')
        const service = await provider()
        return service.createMcpServerDraft(draftInput)
      },
    })
  }
}
