import type { AgentExplicitTarget } from '@/models/agent/agentTarget'
import type { AgentRunDocumentAdapter, AgentRunDocumentSnapshot, AgentRunSnapshot } from './types'
import { markdownFromCanonicalBlock } from './agentRunSupport'

export type AgentTargetHydrationResult =
  | { ok: true; targets: AgentExplicitTarget[] }
  | { ok: false; error: string }

export async function hydrateExplicitDocumentTargets(
  snapshot: AgentRunSnapshot,
  document: AgentRunDocumentAdapter,
): Promise<AgentTargetHydrationResult> {
  const targets = snapshot.explicitTargets.map((target) => ({ ...target }))
  for (let index = 0; index < targets.length; index += 1) {
    const explicitTarget = targets[index]!
    if (explicitTarget.kind !== 'document') continue
    if (explicitTarget.id === snapshot.document.id) {
      targets[index] = {
        ...explicitTarget,
        content: snapshot.document.blocks
          .map(
            (block) =>
              `[block id=${block.id} revision=${snapshot.document.revision ?? 'unknown'}]\n${block.markdown || block.text}`,
          )
          .join('\n\n'),
        revision: snapshot.document.revision ?? undefined,
      }
      continue
    }

    const target = await document.readDocument(explicitTarget.id)
    if (!target) {
      return { ok: false, error: `目标文件“${explicitTarget.title}”不存在或已被删除。` }
    }
    const blocks = await document.listDocumentBlocks(target.id)
    targets[index] = {
      ...explicitTarget,
      revision: target.revision,
      content: blocks
        .map(
          (block) =>
            `[block id=${block.id} revision=${target.revision}]\n${markdownFromCanonicalBlock(block.contentJson, block.plainText)}`,
        )
        .filter(Boolean)
        .join('\n\n'),
    }
  }
  return { ok: true, targets }
}

export async function hydrateCanonicalDocumentSnapshot(
  snapshot: AgentRunDocumentSnapshot,
  document: AgentRunDocumentAdapter,
): Promise<AgentRunDocumentSnapshot> {
  if (snapshot.blocks.length > 0 || !snapshot.id) return snapshot

  const canonicalBlocks = await document.listDocumentBlocks(snapshot.id)
  const blocks = canonicalBlocks.map((block) => ({
    id: block.id,
    type: block.type,
    text: block.plainText,
    markdown: markdownFromCanonicalBlock(block.contentJson, block.plainText),
    index: block.index,
  }))
  return {
    ...snapshot,
    blocks,
    text: snapshot.text || canonicalBlocks.map((block) => block.plainText).join('\n'),
    markdown:
      snapshot.markdown ||
      blocks
        .map((block) => block.markdown || block.text)
        .filter(Boolean)
        .join('\n\n'),
    revision: snapshot.revision ?? canonicalBlocks[0]?.documentRevision ?? null,
  }
}
