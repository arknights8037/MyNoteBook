import { exportTiptapBlockToMarkdown } from '@/editor/io/documentExport'
import type { AgentRuntimeViewState } from '@/models/agent/agentRuntime'
import type { AgentRunIntent } from '@/models/agent/agentSlashCommand'
import { AI_MODE_OPTIONS, type AiChatMode } from '@/models/ai/aiChatMode'
import type { DocumentSummary } from '@/models/documents/document'
import type { ExecutionPolicy } from '@/models/agent/executionPolicy'
import type { KnowledgeObject } from '@/models/knowledge/knowledge'
import type { AiConversationMessage } from '../useAiConversation'
import type { AgentRunContinuation } from './types'

export function createPersistableRuntimeSnapshot(
  state: AgentRuntimeViewState,
): AgentRuntimeViewState {
  return {
    ...state,
    toolCalls: state.toolCalls.slice(0, 64).map((call) => ({
      ...call,
      argumentsJson: compactRuntimePayload(call.argumentsJson, 'input'),
      resultJson: call.resultJson ? compactRuntimePayload(call.resultJson, 'result') : null,
    })),
    timelineEvents: state.timelineEvents.slice(0, 128).map((event) => ({ ...event })),
    lifecycle: {
      ...state.lifecycle,
      plan: state.lifecycle.plan.slice(0, 64).map((step) => ({
        ...step,
        dependsOn: [...step.dependsOn],
      })),
      pendingApproval: null,
    },
    runEvents: state.runEvents.slice(0, 256).map((event) => ({ ...event })),
    authorizationRequest: null,
  }
}

export function markdownFromCanonicalBlock(contentJson: string, fallback: string): string {
  try {
    return (
      exportTiptapBlockToMarkdown(
        JSON.parse(contentJson) as Parameters<typeof exportTiptapBlockToMarkdown>[0],
      ) || fallback
    )
  } catch {
    return fallback
  }
}

export function resolveWorkspaceDocumentIds(
  documents: DocumentSummary[],
  rootIds: string[],
): Set<string> {
  if (rootIds.length === 0) return new Set(documents.map((document) => document.id))
  const allowed = new Set(rootIds)
  let changed = true
  while (changed) {
    changed = false
    for (const document of documents) {
      if (allowed.has(document.id) || !document.parentId || !allowed.has(document.parentId))
        continue
      allowed.add(document.id)
      changed = true
    }
  }
  return allowed
}

export function buildContinuationPrompt(
  basePrompt: string,
  continuation: AgentRunContinuation,
): string {
  const previousProposal = continuation.patches.map((patch) => ({
    documentId: patch.documentId,
    operation: patch.operation,
    blockId: patch.blockId,
    targetBlockIds: patch.targetBlockIds,
    before: patch.before,
    after: patch.after,
    reason: patch.reason,
  }))
  return [
    basePrompt,
    '',
    '这是同一请求中现有提案的修订，不是新的发现任务。',
    `授权人反馈：${continuation.feedback}`,
    continuation.previousSummary ? `上一版 Agent 汇总：${continuation.previousSummary}` : '',
    `上一版完整提案：${JSON.stringify(previousProposal)}`,
    '保留未受反馈影响且仍然正确的 edit，只修正必要部分；最终必须一次提交完整替代提案。',
  ]
    .filter(Boolean)
    .join('\n')
}

export function restrictToolsForIntent(policy: ExecutionPolicy, intent: AgentRunIntent): void {
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
  if (intent === 'plan' || intent === 'research' || intent === 'review' || intent === 'learning') {
    policy.allowedTools = [...sharedReadTools, 'mcp:*']
    policy.allowWriteProposals = false
    policy.riskLevel = 'read_only'
    return
  }
  if (intent === 'create') {
    policy.allowedTools = [...sharedReadTools, 'create_document', 'create_group']
  }
}

export function projectKnowledgeForBundle(object: {
  id: string
  objectType: string
  title: string
  version: number
  documentId: string | null
  blockId: string | null
  sourceRevision: number | null
  authorityLevel: string
}) {
  return {
    id: object.id,
    objectType: object.objectType,
    title: object.title,
    version: object.version,
    documentId: object.documentId,
    blockId: object.blockId,
    sourceRevision: object.sourceRevision,
    authorityLevel: object.authorityLevel,
  }
}

export function selectRelevantApprovedKnowledge(
  objects: KnowledgeObject[],
  prompt: string,
  limit = 20,
): KnowledgeObject[] {
  const normalizedPrompt = prompt.toLocaleLowerCase().replace(/\s+/g, '')
  const promptTerms = Array.from(
    new Set([
      ...prompt
        .toLocaleLowerCase()
        .split(/[\s,，。！？:：;；/]+/)
        .filter((term) => term.length >= 2),
      ...Array.from({ length: Math.max(0, normalizedPrompt.length - 1) }, (_, index) =>
        normalizedPrompt.slice(index, index + 2),
      ),
    ]),
  )
  const scored = objects.map((object) => {
    const text = `${object.title} ${object.content}`.toLocaleLowerCase()
    const score = promptTerms.reduce(
      (total, term) =>
        total +
        (text.includes(term) ? (object.title.toLocaleLowerCase().includes(term) ? 4 : 1) : 0),
      0,
    )
    return { object, score }
  })
  const matched = scored.filter((entry) => entry.score > 0)
  return (matched.length > 0 ? matched : scored.slice(0, 8))
    .sort(
      (left, right) => right.score - left.score || right.object.updatedAt - left.object.updatedAt,
    )
    .slice(0, limit)
    .map(({ object }) => object)
}

export function getModeLabel(mode: AiChatMode): string {
  return AI_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
}

const MAX_CONVERSATION_CONTEXT_CHARACTERS = 32_000

export function compileConversationContinuationContext(messages: AiConversationMessage[]): string {
  const sections = messages
    .filter(
      (message) => message.status === 'done' && (message.content.trim() || message.researchResult),
    )
    .slice(-12)
    .map(formatConversationMessageForContext)
    .filter(Boolean)
  if (sections.length === 0) return ''

  const kept: string[] = []
  let remaining = MAX_CONVERSATION_CONTEXT_CHARACTERS
  for (const section of sections.reverse()) {
    if (remaining <= 0) break
    const value = section.length > remaining ? section.slice(0, remaining) : section
    kept.unshift(value)
    remaining -= value.length
  }
  return [
    '同一对话的延续上下文：',
    '以下内容用于解释“上面”“这些结论”“继续写入”等指代。Research 条目仍是候选结论；写入时保留其来源与验证限制，不得将未验证内容改写成确定事实。',
    ...kept,
  ].join('\n\n')
}

function compactRuntimePayload(value: string, kind: 'input' | 'result'): string {
  try {
    const compacted = compactRuntimeValue(JSON.parse(value) as unknown, kind, '', 0)
    const serialized = JSON.stringify(compacted)
    if (serialized.length <= 96_000) return serialized
    return JSON.stringify({
      historySnapshot: true,
      originalCharacters: serialized.length,
      preview: compactTextForHistory(serialized, 8_000),
    })
  } catch {
    return compactTextForHistory(value, 8_000)
  }
}

function compactRuntimeValue(
  value: unknown,
  kind: 'input' | 'result',
  key: string,
  depth: number,
): unknown {
  if (depth > 6) return '[历史快照省略更深层级]'
  if (typeof value === 'string') {
    const nested = parseNestedJson(value)
    if (nested !== null) return JSON.stringify(compactRuntimeValue(nested, kind, key, depth + 1))
    if (/^(?:url|uri|href|link|sourceUrl)$/i.test(key)) return value
    const verboseField =
      /(?:markdown|content|text|plainText|instructions|before|after|replacement)/i.test(key)
    const limit = verboseField ? (kind === 'input' ? 2_400 : 1_200) : 4_000
    return compactTextForHistory(value, limit)
  }
  if (Array.isArray(value)) {
    const maximumItems = 20
    const items = value
      .slice(0, maximumItems)
      .map((item) => compactRuntimeValue(item, kind, key, depth + 1))
    if (value.length > maximumItems) {
      items.push({ historySnapshotOmittedItems: value.length - maximumItems })
    }
    return items
  }
  if (!value || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
  const compacted = Object.fromEntries(
    entries
      .slice(0, 48)
      .map(([childKey, childValue]) => [
        childKey,
        compactRuntimeValue(childValue, kind, childKey, depth + 1),
      ]),
  )
  if (entries.length > 48) compacted.historySnapshotOmittedFields = entries.length - 48
  return compacted
}

function parseNestedJson(value: string): unknown | null {
  const trimmed = value.trim()
  if (!trimmed || !['{', '['].includes(trimmed[0]!)) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

function compactTextForHistory(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  return `${value.slice(0, maximum)}\n\n[历史快照仅保留预览；原文共 ${value.length} 字符]`
}

function formatConversationMessageForContext(message: AiConversationMessage): string {
  if (message.role === 'user') return `用户：\n${message.content.trim().slice(0, 4_000)}`
  if (!message.researchResult) {
    return `助手：\n${message.content.trim().slice(0, 6_000)}`
  }

  const candidates = new Map(
    (message.researchCandidates ?? []).map((candidate) => [candidate.itemId, candidate]),
  )
  const items = message.researchResult.items
    .map((item) => {
      const candidate = candidates.get(item.id)
      if (candidate?.decision === 'rejected') return ''
      return [
        `- [${item.kind}] ${candidate?.title ?? item.title}`,
        candidate?.content ?? item.content,
        `验证：${item.validationStatus}；${item.validationMessage}`,
        candidate ? `候选状态：${candidate.decision}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .filter(Boolean)
  return [
    `助手 Research 摘要：${message.researchResult.summary}`,
    'Research 条目：',
    ...items,
    ...(message.researchResult.unresolvedQuestions.length
      ? [
          '未解决问题：',
          ...message.researchResult.unresolvedQuestions.map((question) => `- ${question}`),
        ]
      : []),
  ].join('\n')
}
