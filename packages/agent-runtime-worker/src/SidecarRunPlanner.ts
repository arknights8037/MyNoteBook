import {
  type AgentRunRequestV1,
  type AgentSidecarSubmissionV1,
  type ContextBundle,
  type DomainToolManifestEntry,
} from '@mynotebook/agent-runtime-contracts'
import { createHash } from 'node:crypto'

import {
  createAgentTask,
  type AgentTask,
  type SelectedBlock,
} from '../../../src/models/agent/agent.js'
import { buildDomainToolManifest } from '../../../src/services/agent/DomainToolManifest.js'
import {
  createDefaultAgentExecutionPolicy,
  resolveAgentOutputTokenLimit,
} from '../../../src/services/agent/AgentToolRegistry.js'
import { prepareCognitiveRun } from '../../../src/services/cognitive/CognitiveRunService.js'

export interface SidecarPlannedRun {
  task: AgentTask
  contextBundle: ContextBundle
  request: AgentRunRequestV1
}

/**
 * Pure sidecar planning boundary. UI submits a frozen interaction snapshot;
 * this module creates the task/policy/context/runtime plan without Vue or
 * Tauri imports. Persistence is deliberately delegated to Rust Core.
 */
export async function planSidecarRun(
  submission: AgentSidecarSubmissionV1,
): Promise<SidecarPlannedRun> {
  const objective = submission.objective.trim()
  if (!objective) throw new Error('Agent 请求内容为空。')
  if (!submission.document.id.trim()) throw new Error('Agent 请求缺少目标文档。')
  if (!submission.sessionId.trim()) throw new Error('Agent 请求缺少会话 ID。')

  const targetBlocks = selectTargetBlocks(submission)
  const policy = createDefaultAgentExecutionPolicy(submission.configuredMaxTokens)
  restrictPolicyForIntent(policy, submission.intent)
  const task = createAgentTask({
    id: submission.workItemId,
    runId: submission.runId,
    workflowId: submission.workflowId ?? null,
    sessionId: submission.sessionId,
    documentId: submission.document.id,
    projectId: submission.workspace.projectId,
    conversationId: submission.workspace.conversationId,
    userInstruction: objective,
    contextScope:
      targetBlocks.length > 1
        ? 'selection'
        : targetBlocks.length === 1
          ? 'current_block'
          : 'current_document',
    model: submission.modelPolicy.model,
    provider: submission.modelPolicy.provider,
    executionPolicy: policy,
    correlationId: submission.correlationId,
    causationId: submission.causationId,
  })
  task.status = 'running'
  task.currentStep = '侧车正在准备 Agent 任务'

  const externalTools = submission.externalTools.map((tool) => ({ ...tool }))
  const manifest = buildDomainToolManifest(externalTools)
  const context = compileContext(submission, targetBlocks)
  const cognitive = isCognitiveIntent(submission.intent)
    ? prepareCognitiveRun({
        modeId: submission.intent,
        baseExecutionPolicy: policy,
        externalTools,
        baseSafety: submission.systemInstructions,
        skillInstructions: submission.skillInstructions,
        task: objective,
        context,
      })
    : null
  const executionPolicy = cognitive?.spec.executionPolicy ?? policy
  const contextBundle = createSidecarContextBundle({
    taskId: task.id,
    correlationId: task.correlationId,
    causationId: task.causationId,
    query: objective,
    documentId: submission.document.id,
    contextScope: task.contextScope,
    currentRevision: submission.document.revision ?? 0,
    provider: submission.modelPolicy.provider,
    model: submission.modelPolicy.model,
    executionPolicy,
    sources: contextSources(submission, targetBlocks),
  })
  task.contextBundleId = contextBundle.id

  const request: AgentRunRequestV1 = {
    version: 1,
    runId: submission.runId,
    workItemId: task.id,
    ...(submission.workflowId ? { workflowId: submission.workflowId } : {}),
    sessionId: submission.sessionId,
    objective,
    intent: submission.intent,
    systemInstructions: cognitive?.systemPrompt ?? buildSystemInstructions(submission),
    compiledContext: context,
    contextBundle,
    executionPolicy,
    toolManifest: filterManifestForPolicy(manifest, executionPolicy.allowedTools),
    modelPolicy: {
      ...submission.modelPolicy,
      maxOutputTokens: resolveAgentOutputTokenLimit(
        submission.modelPolicy.maxOutputTokens,
        executionPolicy,
      ),
    },
    ...(cognitive
      ? {
          outputContract: {
            id: cognitive.outputContract.id,
            version: cognitive.outputContract.version,
            jsonSchema: cognitive.outputContract.jsonSchema,
            systemInstruction: cognitive.outputContract.systemInstruction,
          },
        }
      : {}),
    correlationId: submission.correlationId,
    causationId: submission.causationId,
  }
  return { task, contextBundle, request }
}

function selectTargetBlocks(submission: AgentSidecarSubmissionV1): SelectedBlock[] {
  const selected = new Set(submission.document.selectedBlockIds)
  const blocks = submission.document.blocks.map((block) => ({ ...block }))
  const chosen = blocks.filter((block) => selected.has(block.id))
  if (chosen.length > 0) return chosen
  return submission.intent === 'create' || isCognitiveIntent(submission.intent) ? [] : blocks
}

function compileContext(
  submission: AgentSidecarSubmissionV1,
  targetBlocks: SelectedBlock[],
): string {
  if (submission.explicitTargets.length > 0) {
    return [
      `当前 Agent 项目：${submission.workspace.projectName || '未分组项目'}`,
      `项目工作区根范围：${submission.workspace.rootDocumentIds.join('、') || '未限制'}`,
      '显式目标：',
      ...submission.explicitTargets.map((target) =>
        [
          `- ${target.title}（${target.kind}，id=${target.id}，revision=${target.revision ?? '未知'}）`,
          target.content?.trim() || '（未提供预载内容，需要使用只读工具获取。）',
        ].join('\n'),
      ),
    ].join('\n\n')
  }
  const text = submission.document.markdown || submission.document.text
  return [
    `当前 Agent 项目：${submission.workspace.projectName || '未分组项目'}`,
    `工作区根范围：${submission.workspace.rootDocumentIds.join('、') || '未限制'}`,
    `文档：${submission.document.title}（id=${submission.document.id}，revision=${submission.document.revision ?? '未知'}）`,
    targetBlocks.length > 0
      ? ['本次可修改目标块：', ...targetBlocks.map(formatBlock)].join('\n\n')
      : '本次未冻结具体修改块；需要内容时必须使用只读工具读取。',
    text ? `文档摘要：\n${text.slice(0, 16_000)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function contextSources(
  submission: AgentSidecarSubmissionV1,
  targetBlocks: SelectedBlock[],
): Array<{
  documentId: string
  blockId?: string
  documentTitle: string
  revision: number
  contentSnippet: string
}> {
  const revision = submission.document.revision ?? 0
  if (targetBlocks.length > 0) {
    return targetBlocks.map((block) => ({
      documentId: submission.document.id,
      blockId: block.id,
      documentTitle: submission.document.title,
      revision,
      contentSnippet: block.markdown || block.text,
    }))
  }
  return [
    {
      documentId: submission.document.id,
      documentTitle: submission.document.title,
      revision,
      contentSnippet: submission.document.markdown || submission.document.text,
    },
  ]
}

function createSidecarContextBundle(input: {
  taskId: string
  correlationId: string
  causationId: string | null
  query: string
  documentId: string
  contextScope: string
  currentRevision: number
  provider: AgentSidecarSubmissionV1['modelPolicy']['provider']
  model: string
  executionPolicy: AgentRunRequestV1['executionPolicy']
  sources: ReturnType<typeof contextSources>
}): ContextBundle {
  const material = {
    version: 2 as const,
    taskId: input.taskId,
    scope: {
      documentId: input.documentId,
      contextScope: input.contextScope,
      currentRevision: input.currentRevision,
    },
    permissionSnapshot: {
      actor: 'local_user' as const,
      canReadKnowledge: true as const,
      canProposeWrites: input.executionPolicy.allowWriteProposals,
    },
    sources: input.sources.map((source) => ({
      kind: 'document_block' as const,
      documentId: source.documentId,
      blockId: source.blockId ?? null,
      revision: source.revision,
      title: source.documentTitle,
      contentHash: sha256(source.contentSnippet),
      contentSnapshot: source.contentSnippet,
    })),
    activeRules: [],
    decisions: [],
    conflicts: [],
    compiler: {
      strategy: 'fts5-current-document-v1' as const,
      version: 1 as const,
      query: input.query,
      tokenBudget: input.executionPolicy.tokenBudget,
      targetProvider: input.provider,
      targetModel: input.model,
      executionPolicy: input.executionPolicy,
    },
  }
  return {
    id: createId(),
    ...material,
    snapshotHash: sha256(stableJson(material)),
    correlationId: input.correlationId,
    causationId: input.causationId,
    createdAt: Date.now(),
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function buildSystemInstructions(submission: AgentSidecarSubmissionV1): string {
  return [
    submission.systemInstructions,
    submission.skillInstructions ?? '',
    '所有领域事实必须通过冻结 Tool Manifest 中的受控工具读取。',
    '写入建议只能通过提案工具提交；提案不代表已写入文档。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function filterManifestForPolicy(
  manifest: DomainToolManifestEntry[],
  allowedTools: string[],
): DomainToolManifestEntry[] {
  const allowed = new Set(allowedTools)
  return manifest.filter(
    (tool) => allowed.has(tool.name) || (tool.source.kind === 'mcp' && allowed.has('mcp:*')),
  )
}

function formatBlock(block: SelectedBlock): string {
  return `[${block.id}] ${block.markdown || block.text}`
}

function isCognitiveIntent(
  intent: AgentSidecarSubmissionV1['intent'],
): intent is 'research' | 'review' | 'learning' {
  return intent === 'research' || intent === 'review' || intent === 'learning'
}

function restrictPolicyForIntent(
  policy: AgentRunRequestV1['executionPolicy'],
  intent: AgentSidecarSubmissionV1['intent'],
): void {
  const sharedReadTools = [
    'get_current_document',
    'get_selected_blocks',
    'get_document_outline',
    'search_documents',
    'list_document_groups',
    'read_document',
    'list_mind_maps',
    'read_mind_map',
    'find_blocks_by_regex',
    'read_skill_file',
    'request_authorizer_input',
    'report_progress',
  ]
  const diagnosticReadTools = [
    'execute_shell',
    'inspect_environment_paths',
    'discover_local_tools',
    'get_system_info',
  ]
  if (intent === 'signal') {
    policy.allowedTools = [
      'search_documents',
      'list_document_groups',
      'read_document',
      'list_mind_maps',
      'read_mind_map',
      'read_personal_organizer',
      'upsert_personal_todo',
      'upsert_personal_calendar_event',
    ]
    policy.allowWriteProposals = false
    policy.allowUserInput = false
    policy.riskLevel = 'propose_write'
    return
  }
  if (intent === 'plan' || isCognitiveIntent(intent)) {
    policy.allowedTools = [...sharedReadTools, ...diagnosticReadTools, 'mcp:*']
    policy.allowWriteProposals = false
    policy.riskLevel = 'read_only'
    return
  }
  if (intent === 'create') {
    policy.allowedTools = [...sharedReadTools, 'create_document', 'create_group']
  }
}

function createId(): string {
  return globalThis.crypto.randomUUID()
}
