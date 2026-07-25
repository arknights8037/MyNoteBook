import { z } from 'zod'

import {
  insertBlocksCommandSchema,
  replaceBlockCommandSchema,
  type AgentWriteCommand,
} from '@/services/agent/AgentWriteContract'

export const documentEditSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace'),
    targetBlockIds: z.array(z.string().trim().min(1)).min(1),
    content: z.string().min(1),
    reason: z.string().trim().min(1),
  }),
  z.object({
    kind: z.enum(['insert_before', 'insert_after', 'append']),
    anchorBlockId: z.string().trim().min(1),
    content: z.string().min(1),
    reason: z.string().trim().min(1),
  }),
])

export const documentEditGroupSchema = z
  .object({
    documentId: z.string().trim().min(1),
    edits: z.array(documentEditSchema).min(1).max(50),
  })
  .superRefine((group, context) => {
    const targets = new Set<string>()
    for (const [editIndex, edit] of group.edits.entries()) {
      const blockIds = edit.kind === 'replace' ? edit.targetBlockIds : [edit.anchorBlockId]
      if (new Set(blockIds).size !== blockIds.length) {
        context.addIssue({
          code: 'custom',
          path: ['edits', editIndex],
          message: '单个 replace edit 不能重复声明同一个目标块。',
        })
      }
      for (const blockId of blockIds) {
        if (targets.has(blockId)) {
          context.addIssue({
            code: 'custom',
            path: ['edits', editIndex],
            message: '同一文档内的 edits 不能重复修改或锚定同一个块；请合并成一个 replace edit。',
          })
        }
        targets.add(blockId)
      }
    }
  })

export const documentEditProposalSchema = z
  .object({
    documents: z.array(documentEditGroupSchema).min(1).max(20),
    summary: z.string().trim().min(1),
  })
  .superRefine((proposal, context) => {
    const documentIds = proposal.documents.map((document) => document.documentId)
    if (new Set(documentIds).size !== documentIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: '同一文档只能在 documents 中出现一次；请合并该文档的 edits。',
      })
    }
  })

export function assertDisjointCommandTargets(commands: AgentWriteCommand[]): void {
  const blockCommands = commands.filter(
    (
      command,
    ): command is
      | z.infer<typeof replaceBlockCommandSchema>
      | z.infer<typeof insertBlocksCommandSchema> =>
      command.tool === 'replace_block' || command.tool === 'insert_blocks',
  )
  const regexCommands = commands.filter((command) => command.tool === 'replace_text_by_regex')
  if (regexCommands.length > 1 || (regexCommands.length > 0 && blockCommands.length > 0)) {
    throw new Error(
      '正则替换不能与其他块修改混在同一批提案中；请改为一批 targetBlockIds 互不重叠的 Patch。',
    )
  }

  const targets = new Set<string>()
  for (const command of blockCommands) {
    const blockId = command.tool === 'replace_block' ? command.blockId : command.anchorBlockId
    const key = `${command.documentId ?? '__current__'}:${blockId}`
    if (targets.has(key)) {
      throw new Error(
        '多个写命令不能修改或锚定同一个目标块；请合并为一个 replace_block，或提交一个合并后的复杂 Patch。',
      )
    }
    targets.add(key)
  }
}
