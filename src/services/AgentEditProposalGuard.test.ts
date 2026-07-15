import { describe, expect, it } from 'vitest'

import {
  parseReadDocumentProvenance,
  validateDocumentEditProvenance,
} from './AgentEditProposalGuard'

describe('AgentEditProposalGuard', () => {
  const readable = {
    documentId: 'doc-1',
    documentTitle: 'Runtime',
    expectedVersion: 3,
    blocks: [
      { id: 'block-1', type: 'paragraph', text: 'before', index: 0 },
      { id: 'block-2', type: 'paragraph', text: 'anchor', index: 1 },
    ],
  }

  it('parses canonical read_document provenance', () => {
    expect(
      parseReadDocumentProvenance(
        {
          id: 'doc-1',
          title: 'Runtime',
          revision: 3,
          blocks: [
            { id: 'block-1', blockType: 'paragraph', blockIndex: 0, plainText: 'before' },
          ],
        },
        'doc-1',
      ),
    ).toEqual({ ...readable, blocks: [readable.blocks[0]] })
  })

  it('rejects unread documents, invented targets, and no-op replacements at tool time', () => {
    const proposal = (documentId: string, targetBlockIds: string[], content = 'after') => ({
      documents: [
        {
          documentId,
          edits: [{ kind: 'replace' as const, targetBlockIds, content, reason: 'sync' }],
        },
      ],
      summary: 'sync',
    })
    expect(() => validateDocumentEditProvenance(proposal('doc-2', ['block-1']), [readable])).toThrow(
      '尚未通过本次 read_document',
    )
    expect(() =>
      validateDocumentEditProvenance(proposal('doc-1', ['invented']), [readable]),
    ).toThrow('不属于本次 read_document')
    expect(() =>
      validateDocumentEditProvenance(proposal('doc-1', ['block-1'], 'before'), [readable]),
    ).toThrow('no-op')
    expect(() =>
      validateDocumentEditProvenance(proposal('doc-1', ['block-1'], 'after'), [readable]),
    ).not.toThrow()
  })
})
