import type { BlockPatch, SelectedBlock } from '@/models/agent'

export interface RegexReplaceCommand {
  tool: 'replace_text_by_regex'
  pattern: string
  replacement: string
  flags?: string
  blockIds?: string[]
  reason?: string
}

export interface ReplaceBlockCommand {
  tool: 'replace_block'
  blockId: string
  content: string
  reason?: string
}

export interface InsertBlocksCommand {
  tool: 'insert_blocks'
  anchorBlockId: string
  position: 'before' | 'after' | 'append'
  content: string
  reason?: string
}

export interface CreateDocumentCommand {
  tool: 'create_document'
  title: string
  content: string
  parentDocumentId?: string | null
  reason?: string
}

export interface CreateGroupCommand {
  tool: 'create_group'
  title: string
  initialDocument?: {
    title: string
    content: string
  }
  reason?: string
}

export type AgentWriteCommand =
  | RegexReplaceCommand
  | ReplaceBlockCommand
  | InsertBlocksCommand
  | CreateDocumentCommand
  | CreateGroupCommand

export async function createAgentCommandPatches(input: {
  command: AgentWriteCommand
  taskId: string
  documentId: string
  expectedVersion: number
  blocks: SelectedBlock[]
  allowedParentDocumentIds?: string[]
  replaceBlocksByRegex?: RegexReplaceExecutor
  createId: () => string
}): Promise<BlockPatch[]> {
  if (input.command.tool === 'replace_text_by_regex') return createRegexReplacePatches(input)
  if (input.command.tool === 'create_group') {
    const title = input.command.title.trim().slice(0, 160)
    const initialTitle = input.command.initialDocument?.title.trim().slice(0, 160) ?? ''
    const initialContent = input.command.initialDocument?.content.trim() ?? ''
    if (!title) throw new Error('新分组名称不能为空。')
    if (input.command.initialDocument && (!initialTitle || !initialContent)) {
      throw new Error('分组的初始文档标题和内容不能为空。')
    }
    if (initialContent.length > 80_000) throw new Error('初始文档内容过长。')
    const patchId = input.createId()
    const groupId = input.createId()
    const childDocumentId = input.command.initialDocument ? input.createId() : ''
    return [
      {
        patchId,
        taskId: input.taskId,
        operation: 'create_group',
        documentId: groupId,
        blockId: childDocumentId,
        targetBlockIds: [],
        expectedVersion: 0,
        before: initialTitle,
        after: initialContent,
        reason: input.command.reason?.trim() || '创建新的知识库分组。',
        accepted: true,
        documentTitle: title,
        parentDocumentId: null,
      },
    ]
  }
  if (input.command.tool === 'create_document') {
    const title = input.command.title.trim().slice(0, 160)
    const content = input.command.content.trim()
    if (!title || !content) throw new Error('新文档标题和内容不能为空。')
    if (content.length > 80_000) throw new Error('新文档内容过长。')
    if (
      input.command.parentDocumentId !== undefined &&
      input.command.parentDocumentId !== null &&
      input.command.parentDocumentId !== input.documentId &&
      !input.allowedParentDocumentIds?.includes(input.command.parentDocumentId)
    ) {
      throw new Error('新文档父级必须是本次任务读取到的真实分组或当前文档。')
    }
    return [
      {
        patchId: input.createId(),
        taskId: input.taskId,
        operation: 'create_document',
        documentId: input.createId(),
        blockId: '',
        targetBlockIds: [],
        expectedVersion: 0,
        before: '',
        after: content,
        reason: input.command.reason?.trim() || '创建新的知识库文档。',
        accepted: true,
        documentTitle: title,
        parentDocumentId:
          input.command.parentDocumentId === undefined
            ? input.documentId
            : input.command.parentDocumentId,
      },
    ]
  }

  const targetId =
    input.command.tool === 'replace_block' ? input.command.blockId : input.command.anchorBlockId
  const target = input.blocks.find((block) => block.id === targetId)
  if (!target) throw new Error(`写命令目标块 ${targetId} 不在本次允许范围内。`)
  const content = input.command.content.trim()
  if (!content) throw new Error('写命令内容不能为空。')
  if (content.length > 40_000) throw new Error('写命令内容过长。')
  const operation =
    input.command.tool === 'replace_block'
      ? 'replace'
      : input.command.position === 'before'
        ? 'insert_before'
        : input.command.position === 'after'
          ? 'insert_after'
          : 'append'
  return [
    {
      patchId: input.createId(),
      taskId: input.taskId,
      operation,
      documentId: input.documentId,
      blockId: target.id,
      targetBlockIds: [target.id],
      expectedVersion: input.expectedVersion,
      before: target.text,
      after: content,
      reason:
        input.command.reason?.trim() ||
        (operation === 'replace' ? '替换目标块。' : '在目标块附近插入内容。'),
      accepted: true,
    },
  ]
}

export type RegexReplaceExecutor = (input: {
  pattern: string
  replacement: string
  flags: string
  blocks: SelectedBlock[]
}) => Promise<SelectedBlock[]>

export async function createRegexReplacePatches(input: {
  command: RegexReplaceCommand
  taskId: string
  documentId: string
  expectedVersion: number
  blocks: SelectedBlock[]
  replaceBlocksByRegex?: RegexReplaceExecutor
  createId: () => string
}): Promise<BlockPatch[]> {
  const command = input.command
  if (command.pattern.length === 0 || command.pattern.length > 240) {
    throw new Error('正则表达式不能为空且不得超过 240 个字符。')
  }
  if (command.replacement.length > 4000) throw new Error('替换文本过长。')
  const flags = normalizeRegexFlags(command.flags)
  const targetIds = new Set(
    command.blockIds?.filter(Boolean) ?? input.blocks.map((block) => block.id),
  )
  const targets = input.blocks.filter((block) => targetIds.has(block.id))
  if (targets.length === 0) throw new Error('正则工具没有找到可操作的目标块。')
  if (!input.replaceBlocksByRegex) {
    throw new Error('当前组合未提供安全正则替换器。')
  }
  const replaceBlocks = input.replaceBlocksByRegex
  const replacements = await replaceBlocks({
    pattern: command.pattern,
    replacement: command.replacement,
    flags,
    blocks: targets,
  })
  const replacementsById = new Map(replacements.map((block) => [block.id, block.text]))

  return targets.flatMap((block) => {
    const after = replacementsById.get(block.id)
    if (after === undefined || after === block.text) return []
    return [
      {
        patchId: input.createId(),
        taskId: input.taskId,
        operation: 'replace',
        documentId: input.documentId,
        blockId: block.id,
        targetBlockIds: [block.id],
        expectedVersion: input.expectedVersion,
        before: block.text,
        after,
        reason: command.reason?.trim() || `按正则 /${command.pattern}/${flags} 执行文本替换。`,
        accepted: true,
      },
    ]
  })
}

function normalizeRegexFlags(value: string | undefined): string {
  const flags = (value ?? 'g').replace(/[^gim]/g, '')
  return Array.from(new Set(flags.split(''))).join('') || 'g'
}
