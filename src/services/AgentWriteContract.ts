import { z } from 'zod'

export const regexReplaceCommandSchema = z.object({
  tool: z.literal('replace_text_by_regex'),
  pattern: z.string().min(1).max(240),
  replacement: z.string().max(4_000),
  flags: z.string().optional(),
  blockIds: z.array(z.string().trim().min(1)).optional(),
  reason: z.string().optional(),
})

export const replaceBlockCommandSchema = z.object({
  tool: z.literal('replace_block'),
  documentId: z.string().trim().min(1).optional(),
  blockId: z.string().trim().min(1),
  content: z.string().min(1),
  reason: z.string().optional(),
})

export const insertBlocksCommandSchema = z.object({
  tool: z.literal('insert_blocks'),
  documentId: z.string().trim().min(1).optional(),
  anchorBlockId: z.string().trim().min(1),
  position: z.enum(['before', 'after', 'append']),
  content: z.string().min(1),
  reason: z.string().optional(),
})

export const createDocumentCommandSchema = z.object({
  tool: z.literal('create_document'),
  title: z.string().min(1),
  content: z.string().min(1),
  parentDocumentId: z.string().nullable().optional(),
  reason: z.string().optional(),
})

export const createGroupCommandSchema = z.object({
  tool: z.literal('create_group'),
  title: z.string().min(1),
  initialDocument: z
    .object({
      title: z.string().min(1),
      content: z.string().min(1),
    })
    .optional(),
  reason: z.string().optional(),
})

export const agentWriteCommandSchema = z.discriminatedUnion('tool', [
  regexReplaceCommandSchema,
  replaceBlockCommandSchema,
  insertBlocksCommandSchema,
  createDocumentCommandSchema,
  createGroupCommandSchema,
])

export const agentPatchProposalSchema = z
  .object({
    documentId: z.string().trim().min(1),
    operation: z.enum(['replace', 'insert_before', 'insert_after', 'append']),
    blockId: z.string().trim().min(1),
    targetBlockIds: z.array(z.string().trim().min(1)).min(1),
    after: z.string().min(1),
    reason: z.string().trim().min(1),
  })
  .superRefine((patch, context) => {
    if (new Set(patch.targetBlockIds).size !== patch.targetBlockIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['targetBlockIds'],
        message: '单个 Patch 的 targetBlockIds 不能包含重复块。',
      })
    }
    if (!patch.targetBlockIds.includes(patch.blockId)) {
      context.addIssue({
        code: 'custom',
        path: ['blockId'],
        message: 'Patch 的 blockId 必须包含在 targetBlockIds 中。',
      })
    }
    if (patch.operation !== 'replace' && patch.targetBlockIds.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['targetBlockIds'],
        message: '插入 Patch 只能使用一个稳定锚点块。',
      })
    }
  })

export const agentPatchProposalBatchSchema = z
  .array(agentPatchProposalSchema)
  .max(50)
  .superRefine((patches, context) => {
    const targets = new Set<string>()
    for (const [patchIndex, patch] of patches.entries()) {
      for (const blockId of patch.targetBlockIds) {
        const key = `${patch.documentId}:${blockId}`
        if (targets.has(key)) {
          context.addIssue({
            code: 'custom',
            path: [patchIndex, 'targetBlockIds'],
            message:
              '同一批 Patch 不能重复修改同一个目标块；请把该块的替换与补充合并成一个 replace Patch。',
          })
        }
        targets.add(key)
      }
    }
  })

export type RegexReplaceCommand = z.infer<typeof regexReplaceCommandSchema>
export type ReplaceBlockCommand = z.infer<typeof replaceBlockCommandSchema>
export type InsertBlocksCommand = z.infer<typeof insertBlocksCommandSchema>
export type CreateDocumentCommand = z.infer<typeof createDocumentCommandSchema>
export type CreateGroupCommand = z.infer<typeof createGroupCommandSchema>
export type AgentWriteCommand = z.infer<typeof agentWriteCommandSchema>
export type AgentPatchProposal = z.infer<typeof agentPatchProposalSchema>

export function parseAgentWriteCommands(value: unknown): AgentWriteCommand[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    const parsed = agentWriteCommandSchema.safeParse(candidate)
    return parsed.success ? [parsed.data] : []
  })
}
