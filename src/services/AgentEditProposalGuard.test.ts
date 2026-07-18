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

  it('requires a tableBlock replacement to remain a Markdown table', () => {
    const tableDocument = {
      documentId: 'doc-table',
      documentTitle: 'Tools',
      expectedVersion: 4,
      blocks: [
        {
          id: 'table-1',
          type: 'tableBlock',
          text: '工具\t风险\nread_document\tread',
          markdown: '| 工具 | 风险 |\n| --- | --- |\n| read_document | read |',
          index: 0,
        },
      ],
    }
    const proposal = (content: string) => ({
      documents: [
        {
          documentId: 'doc-table',
          edits: [
            {
              kind: 'replace' as const,
              targetBlockIds: ['table-1'],
              content,
              reason: '更新工具表',
            },
          ],
        },
      ],
      summary: '更新表格',
    })

    expect(() =>
      validateDocumentEditProvenance(
        proposal('工具\t风险\nread_document\twrite proposal'),
        [tableDocument],
      ),
    ).toThrow('Markdown pipe table')
    expect(() =>
      validateDocumentEditProvenance(
        proposal('| 工具 | 风险 |\n| --- | --- |\n| read_document | write proposal |'),
        [tableDocument],
      ),
    ).not.toThrow()
    expect(() =>
      validateDocumentEditProvenance(
        proposal('| 工具 | 风险 |\n| --- | --- |\n| read_document | read |'),
        [tableDocument],
      ),
    ).toThrow('no-op')
  })

  it('rejects Markdown replacement for rich blocks without a lossless codec', () => {
    const richDocument = {
      ...readable,
      blocks: [{ id: 'asset-1', type: 'attachmentBlock', text: '需求.pdf', index: 0 }],
    }

    expect(() =>
      validateDocumentEditProvenance(
        {
          documents: [
            {
              documentId: 'doc-1',
              edits: [
                {
                  kind: 'replace',
                  targetBlockIds: ['asset-1'],
                  content: '[需求.pdf](asset://asset-1)',
                  reason: '更新附件',
                },
              ],
            },
          ],
          summary: '更新附件',
        },
        [richDocument],
      ),
    ).toThrow('不能通过 Markdown Agent Patch 无损替换')
  })
})
