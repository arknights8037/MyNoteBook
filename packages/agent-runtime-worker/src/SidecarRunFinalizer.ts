import type {
  AgentRunRequestV1,
  AgentRunResult,
  AgentSidecarFinalizationV1,
  AgentSidecarPatchDraft,
} from '@mynotebook/agent-runtime-contracts'

interface SidecarDocumentBlock {
  id: string
  text: string
  markdown?: string
}

/**
 * Converts a completed Worker result to a durable proposal projection. This is
 * intentionally side-effect free: Rust Core persists the output and the
 * existing Rust patch transaction remains the only document writer.
 */
export async function finalizeSidecarRun(
  request: AgentRunRequestV1,
  result: AgentRunResult,
  replaceBlocksByRegex?: (input: {
    pattern: string
    replacement: string
    flags: string
    blocks: SidecarDocumentBlock[]
  }) => Promise<SidecarDocumentBlock[]>,
): Promise<AgentSidecarFinalizationV1> {
  const output = parseOutput(result.output)
  const sources = sourcesFromContext(request)
  const patches =
    output.outcome === 'proposal'
      ? await proposalPatches(request, output, sources, replaceBlocksByRegex)
      : []
  if (output.outcome === 'proposal' && patches.length === 0) {
    throw new Error('Agent 未返回有效的结构化 Patch。')
  }
  const summary = output.finalAnswer || defaultSummary(output.outcome, patches.length)
  const taskStatus = patches.length > 0 ? ('waiting_confirmation' as const) : ('completed' as const)
  return {
    version: 1,
    taskId: request.workItemId,
    runId: request.runId,
    outcome: output.outcome,
    summary,
    taskStatus,
    currentStep:
      taskStatus === 'waiting_confirmation'
        ? '等待用户确认修改'
        : output.outcome === 'blocked'
          ? '需要补充信息'
          : '内容无需修改',
    completedAt: taskStatus === 'completed' ? Date.now() : null,
    patches,
    sources,
    report: {
      version: 1,
      outcome: output.outcome,
      summary,
      patchCount: patches.length,
      targetDocumentIds: [...new Set(patches.map((patch) => patch.documentId))],
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    },
  }
}

function parseOutput(value: string): {
  outcome: 'proposal' | 'no_change' | 'blocked'
  finalAnswer: string
  patches: Array<Record<string, unknown>>
  commands: Array<Record<string, unknown>>
} {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return {
      outcome:
        parsed.outcome === 'no_change' || parsed.outcome === 'blocked'
          ? parsed.outcome
          : 'proposal',
      finalAnswer: typeof parsed.finalAnswer === 'string' ? parsed.finalAnswer.trim() : '',
      patches: Array.isArray(parsed.patches) ? parsed.patches.map(asRecord) : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands.map(asRecord) : [],
    }
  } catch {
    throw new Error('Agent 终态不是可审计的 JSON 提案。')
  }
}

async function proposalPatches(
  request: AgentRunRequestV1,
  output: ReturnType<typeof parseOutput>,
  sources: AgentSidecarFinalizationV1['sources'],
  replaceBlocksByRegex?: Parameters<typeof finalizeSidecarRun>[2],
): Promise<AgentSidecarPatchDraft[]> {
  if (output.commands.length > 0 && output.patches.length > 0) {
    throw new Error('commands 和 patches 不能混合提交。')
  }
  const readable = readableBlocks(request)
  const patches = output.patches.map((patch) => createPatch(request, patch, readable))
  const commandPatches = (
    await Promise.all(
      output.commands.map((command) =>
        createCommandPatch(request, command, readable, replaceBlocksByRegex),
      ),
    )
  ).flat()
  const combined = [...patches, ...commandPatches]
  assertDisjoint(combined)
  for (const patch of combined) {
    if (
      !['create_document', 'create_group'].includes(patch.operation) &&
      !sources.some((source) => source.documentId === patch.documentId)
    ) {
      throw new Error(`文档 ${patch.documentId} 未作为本次任务来源读取。`)
    }
  }
  return combined
}

function readableBlocks(
  request: AgentRunRequestV1,
): Map<string, { revision: number; title: string; blocks: SidecarDocumentBlock[] }> {
  const result = new Map<
    string,
    { revision: number; title: string; blocks: SidecarDocumentBlock[] }
  >()
  const grouped = new Map<
    string,
    Array<{ blockId: string | null; content: string | null; revision: number; title: string }>
  >()
  for (const source of request.contextBundle.sources) {
    const items = grouped.get(source.documentId) ?? []
    items.push({
      blockId: source.blockId,
      content: source.contentSnapshot,
      revision: source.revision,
      title: source.title,
    })
    grouped.set(source.documentId, items)
  }
  for (const [documentId, items] of grouped) {
    result.set(documentId, {
      revision: items[0]?.revision ?? 0,
      title: items[0]?.title ?? documentId,
      blocks: items.flatMap((item) =>
        item.blockId ? [{ id: item.blockId, text: item.content ?? '' }] : [],
      ),
    })
  }
  return result
}

function createPatch(
  request: AgentRunRequestV1,
  raw: Record<string, unknown>,
  readable: ReturnType<typeof readableBlocks>,
): AgentSidecarPatchDraft {
  const operation = readOperation(raw.operation)
  const documentId = readString(raw.documentId, currentDocumentId(request))
  const scope = readable.get(documentId)
  const targetBlockIds = readStringArray(raw.targetBlockIds)
  const blockId = readString(raw.blockId, targetBlockIds[0] ?? '')
  if (
    !scope ||
    !operation ||
    !blockId ||
    !targetBlockIds.length ||
    !targetBlockIds.includes(blockId)
  ) {
    throw new Error('Patch 目标不在冻结的可读范围内。')
  }
  if (targetBlockIds.some((id) => !scope.blocks.some((block) => block.id === id))) {
    throw new Error('Patch 包含未读取的目标块。')
  }
  if (operation !== 'replace' && targetBlockIds.length !== 1) {
    throw new Error('插入 Patch 只能使用一个稳定锚点块。')
  }
  const after = readString(raw.after, '').trim()
  if (!after) throw new Error('Patch 内容不能为空。')
  return {
    patchId: createId(),
    taskId: request.workItemId,
    operation,
    documentId,
    blockId,
    targetBlockIds,
    expectedVersion: scope.revision,
    before: scope.blocks
      .filter((block) => targetBlockIds.includes(block.id))
      .map((block) => block.text)
      .join('\n\n'),
    after,
    reason: readString(raw.reason, 'Agent 生成的结构化修改。').trim() || 'Agent 生成的结构化修改。',
  }
}

async function createCommandPatch(
  request: AgentRunRequestV1,
  command: Record<string, unknown>,
  readable: ReturnType<typeof readableBlocks>,
  replaceBlocksByRegex?: Parameters<typeof finalizeSidecarRun>[2],
): Promise<AgentSidecarPatchDraft[]> {
  const tool = readString(command.tool, '')
  if (tool === 'replace_block') {
    return [
      createPatch(
        request,
        {
          documentId: command.documentId,
          operation: 'replace',
          blockId: command.blockId,
          targetBlockIds: [command.blockId],
          after: command.content,
          reason: command.reason,
        },
        readable,
      ),
    ]
  }
  if (tool === 'insert_blocks') {
    const position = readString(command.position, '')
    return [
      createPatch(
        request,
        {
          documentId: command.documentId,
          operation:
            position === 'before'
              ? 'insert_before'
              : position === 'after'
                ? 'insert_after'
                : 'append',
          blockId: command.anchorBlockId,
          targetBlockIds: [command.anchorBlockId],
          after: command.content,
          reason: command.reason,
        },
        readable,
      ),
    ]
  }
  if (tool === 'create_document') {
    const title = readString(command.title, '').trim()
    const after = readString(command.content, '').trim()
    if (!title || !after) throw new Error('新文档标题和内容不能为空。')
    return [
      {
        patchId: createId(),
        taskId: request.workItemId,
        operation: 'create_document',
        documentId: createId(),
        blockId: '',
        targetBlockIds: [],
        expectedVersion: 0,
        before: '',
        after,
        reason: readString(command.reason, '创建新的知识库文档。'),
        documentTitle: title,
        parentDocumentId:
          typeof command.parentDocumentId === 'string'
            ? command.parentDocumentId
            : currentDocumentId(request),
      },
    ]
  }
  if (tool === 'create_group') {
    const title = readString(command.title, '').trim()
    if (!title) throw new Error('新分组名称不能为空。')
    const initial = asRecord(command.initialDocument)
    const initialTitle = readString(initial.title, '').trim()
    const initialContent = readString(initial.content, '').trim()
    if (Object.keys(initial).length && (!initialTitle || !initialContent))
      throw new Error('分组的初始文档内容无效。')
    return [
      {
        patchId: createId(),
        taskId: request.workItemId,
        operation: 'create_group',
        documentId: createId(),
        blockId: initialContent ? createId() : '',
        targetBlockIds: [],
        expectedVersion: 0,
        before: initialTitle,
        after: initialContent,
        reason: readString(command.reason, '创建新的知识库分组。'),
        documentTitle: title,
        parentDocumentId: null,
      },
    ]
  }
  if (tool === 'replace_text_by_regex') {
    if (!replaceBlocksByRegex) throw new Error('侧车未配置安全正则提案编译器。')
    const documentId = currentDocumentId(request)
    const scope = readable.get(documentId)
    if (!scope) throw new Error('正则替换缺少冻结的目标块。')
    const requested = new Set(readStringArray(command.blockIds))
    const targets = requested.size
      ? scope.blocks.filter((block) => requested.has(block.id))
      : scope.blocks
    const replacements = await replaceBlocksByRegex({
      pattern: readString(command.pattern, ''),
      replacement: readString(command.replacement, ''),
      flags: readString(command.flags, 'g'),
      blocks: targets,
    })
    const byId = new Map(replacements.map((block) => [block.id, block.text]))
    return targets.flatMap((block) => {
      const after = byId.get(block.id)
      return after === undefined || after === block.text
        ? []
        : [
            {
              patchId: createId(),
              taskId: request.workItemId,
              operation: 'replace' as const,
              documentId,
              blockId: block.id,
              targetBlockIds: [block.id],
              expectedVersion: scope.revision,
              before: block.text,
              after,
              reason: readString(command.reason, '按安全正则执行文本替换。'),
            },
          ]
    })
  }
  throw new Error(`不支持的写提案命令：${tool || 'unknown'}。`)
}

function sourcesFromContext(request: AgentRunRequestV1): AgentSidecarFinalizationV1['sources'] {
  const grouped = new Map<string, { documentTitle: string; blockIds: string[] }>()
  for (const source of request.contextBundle.sources) {
    const existing = grouped.get(source.documentId) ?? { documentTitle: source.title, blockIds: [] }
    if (source.blockId && !existing.blockIds.includes(source.blockId))
      existing.blockIds.push(source.blockId)
    grouped.set(source.documentId, existing)
  }
  return [...grouped.entries()].map(([documentId, source]) => ({ documentId, ...source }))
}

function currentDocumentId(request: AgentRunRequestV1): string {
  const documentId = request.contextBundle.scope.documentId
  return typeof documentId === 'string'
    ? documentId
    : (request.contextBundle.sources[0]?.documentId ?? '')
}
function assertDisjoint(patches: AgentSidecarPatchDraft[]): void {
  const seen = new Set<string>()
  for (const patch of patches) {
    for (const blockId of patch.targetBlockIds) {
      const key = `${patch.documentId}:${blockId}`
      if (seen.has(key)) throw new Error('多个 Patch 不能修改同一个目标块。')
      seen.add(key)
    }
  }
}
function defaultSummary(outcome: 'proposal' | 'no_change' | 'blocked', count: number): string {
  return outcome === 'proposal'
    ? `已生成 ${count} 项修改，等待确认。`
    : outcome === 'blocked'
      ? '现有信息不足，任务暂时无法继续。'
      : '当前内容无需修改。'
}
function readOperation(value: unknown): AgentSidecarPatchDraft['operation'] | null {
  return value === 'replace' ||
    value === 'insert_before' ||
    value === 'insert_after' ||
    value === 'append'
    ? value
    : null
}
function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function createId(): string {
  return globalThis.crypto.randomUUID()
}
