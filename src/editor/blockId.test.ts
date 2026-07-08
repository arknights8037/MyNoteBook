import { describe, expect, it } from 'vitest'

import { DOCUMENT_SCHEMA_VERSION, type TiptapDocumentJson } from '@/models/document'
import { parseEditorContentJson, serializeEditorContent } from './editorContent'
import {
  BLOCK_ID_ATTRIBUTE,
  BLOCK_ID_NODE_TYPES,
  cloneNodeWithFreshIds,
  extractUuidFromLegacyId,
  generateBlockId,
  isValidNodeId,
  migrateDocumentNodeIds,
  normalizeDocumentNodeIds,
  validateDocumentNodeIds,
} from './blockId'

const uuidA = 'cb5114f8-0c97-4b7b-ad69-c6c14b44072f'
const uuidB = '08e3ecac-ea04-436b-9242-2ab5e47b2c4f'
const uuidC = 'db91ac83-c1d3-49d1-8ab6-13aef653df84'

describe('node ids', () => {
  it('defines the Tiptap-compatible id attribute for addressable node types', () => {
    expect(BLOCK_ID_ATTRIBUTE).toBe('id')
    expect(BLOCK_ID_NODE_TYPES).toContain('doc')
    expect(BLOCK_ID_NODE_TYPES).toContain('paragraph')
    expect(BLOCK_ID_NODE_TYPES).toContain('heading')
    expect(BLOCK_ID_NODE_TYPES).toContain('listItem')
  })

  it('extracts UUIDs from legacy prefixed ids', () => {
    expect(extractUuidFromLegacyId(`paragraph-${uuidA}`)).toBe(uuidA)
    expect(extractUuidFromLegacyId(`heading-${uuidB}`)).toBe(uuidB)
    expect(extractUuidFromLegacyId(`math-block-${uuidC}`)).toBe(uuidC)
    expect(extractUuidFromLegacyId('not-a-valid-id')).toBeUndefined()
  })

  it('generates unprefixed UUID node ids', () => {
    expect(generateBlockId()).toEqual(expect.stringMatching(uuidRegex()))
  })

  it('keeps an existing valid id and removes legacy blockId', () => {
    const result = migrateDocumentNodeIds({
      type: 'doc',
      attrs: { id: uuidA, blockId: `doc-${uuidB}` },
      content: [{ type: 'paragraph', attrs: { id: uuidB, blockId: `paragraph-${uuidC}` } }],
    })

    expect(result.document.attrs?.id).toBe(uuidA)
    expect(result.document.attrs).not.toHaveProperty('blockId')
    expect(result.document.content?.[0]?.attrs?.id).toBe(uuidB)
    expect(result.document.content?.[0]?.attrs).not.toHaveProperty('blockId')
  })

  it('moves a valid top-level id into attrs.id for Tiptap serialization', () => {
    const result = migrateDocumentNodeIds({
      type: 'doc',
      id: uuidA,
      content: [{ type: 'paragraph', id: uuidB }],
    })

    expect(result.document.attrs?.id).toBe(uuidA)
    expect(result.document).not.toHaveProperty('id')
    expect(result.document.content?.[0]?.attrs?.id).toBe(uuidB)
    expect(result.document.content?.[0]).not.toHaveProperty('id')
  })

  it('migrates prefixed attrs.id values when they appear in imported content', () => {
    const result = migrateDocumentNodeIds({
      type: 'doc',
      attrs: { id: `doc-${uuidA}` },
      content: [{ type: 'paragraph', attrs: { id: `paragraph-${uuidB}` } }],
    })

    expect(result.document.attrs?.id).toBe(uuidA)
    expect(result.document.content?.[0]?.attrs?.id).toBe(uuidB)
  })

  it('generates ids for listItem and does not generate ids for text nodes', () => {
    const result = migrateDocumentNodeIds({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          attrs: { blockId: `bullet-list-${uuidA}` },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
      ],
    })
    const listItem = result.document.content?.[0]?.content?.[0]
    const text = listItem?.content?.[0]?.content?.[0]

    expect(isValidNodeId(listItem?.attrs?.id)).toBe(true)
    expect(text?.attrs).toBeUndefined()
  })

  it('preserves other attrs while removing empty attrs when possible', () => {
    const result = migrateDocumentNodeIds({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { blockId: `heading-${uuidA}`, level: 2, textAlign: null },
          content: [{ type: 'text', text: '标题2' }],
        },
        {
          type: 'paragraph',
          attrs: { blockId: 'bad-id' },
        },
      ],
    })

    expect(result.document.content?.[0]?.attrs).toMatchObject({
      id: uuidA,
      level: 2,
      textAlign: null,
    })
    expect(result.document.content?.[0]?.attrs).not.toHaveProperty('blockId')
    expect(result.document.content?.[1]?.attrs).toEqual({ id: expect.stringMatching(uuidRegex()) })
  })

  it('fixes duplicate ids', () => {
    const result = migrateDocumentNodeIds({
      type: 'doc',
      attrs: { id: uuidA },
      content: [
        { type: 'paragraph', attrs: { id: uuidA } },
        { type: 'heading', attrs: { id: uuidA, level: 1 } },
      ],
    })
    const ids = collectIds(result.document)

    expect(result.duplicateIdsFixed).toBe(2)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('migrates deeply nested lists', () => {
    const result = migrateDocumentNodeIds({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    expect(validateDocumentNodeIds(result.document)).toMatchObject({ valid: true })
    expect(collectIds(result.document)).toHaveLength(6)
  })

  it('migrates collapsibleBlock children', () => {
    const result = migrateDocumentNodeIds({
      type: 'doc',
      content: [
        {
          type: 'collapsibleBlock',
          attrs: { title: 'More' },
          content: [{ type: 'paragraph', attrs: { blockId: `paragraph-${uuidA}` } }],
        },
      ],
    })

    expect(result.document.content?.[0]?.attrs?.id).toEqual(expect.stringMatching(uuidRegex()))
    expect(result.document.content?.[0]?.content?.[0]?.attrs?.id).toBe(uuidA)
  })

  it('is idempotent on the second migration', () => {
    const first = migrateDocumentNodeIds({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { blockId: `paragraph-${uuidA}` } }],
    })
    const second = migrateDocumentNodeIds(first.document)

    expect(second.document).toEqual(first.document)
    expect(second.changed).toBe(false)
    expect(second.generatedIds).toBe(0)
    expect(second.migratedLegacyIds).toBe(0)
  })

  it('cloneNodeWithFreshIds refreshes every structure node id', () => {
    const original = normalizeDocumentNodeIds({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
        },
      ],
    })
    const clone = cloneNodeWithFreshIds(original)

    expect(collectIds(clone)).toHaveLength(4)
    expect(collectIds(clone).some((id) => collectIds(original).includes(id))).toBe(false)
    expect(clone.content?.[0]?.content?.[0]?.content?.[0]?.type).toBe('paragraph')
  })

  it('keeps ids through node type conversion and attrs changes', () => {
    const paragraph = normalizeDocumentNodeIds({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: uuidA } }],
    })
    const converted = normalizeDocumentNodeIds({
      ...paragraph,
      content: [{ ...paragraph.content![0], type: 'heading', attrs: { id: uuidA, level: 2 } }],
    })

    expect(converted.content?.[0]?.attrs?.id).toBe(uuidA)
    expect(converted.content?.[0]?.type).toBe('heading')
  })

  it('handles empty content, missing attrs, and unknown node types without deleting them', () => {
    const result = migrateDocumentNodeIds({
      type: 'doc',
      content: [{ type: 'unknownWidget', custom: { enabled: true } }, { type: 'paragraph' }],
    })

    expect(result.document.content?.[0]?.type).toBe('unknownWidget')
    expect(result.document.content?.[0]).toMatchObject({ custom: { enabled: true } })
    expect(isValidNodeId(result.document.content?.[0]?.attrs?.id)).toBe(true)
    expect(isValidNodeId(result.document.content?.[1]?.attrs?.id)).toBe(true)
  })

  it('keeps ids stable after serialize and parse', () => {
    const document = normalizeDocumentNodeIds({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { blockId: `paragraph-${uuidA}` } }],
    })
    const parsed = parseEditorContentJson(serializeEditorContent(document))

    expect(parsed.content?.[0]?.attrs?.id).toBe(uuidA)
    expect(validateDocumentNodeIds(parsed).valid).toBe(true)
  })

  it('updates embedded schemaVersion from 1 to 2', () => {
    const result = migrateDocumentNodeIds({
      type: 'doc',
      schemaVersion: 1,
      content: [{ type: 'paragraph' }],
    })

    expect((result.document as TiptapDocumentJson & { schemaVersion?: number }).schemaVersion).toBe(
      DOCUMENT_SCHEMA_VERSION,
    )
  })
})

function uuidRegex(): RegExp {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
}

function collectIds(document: TiptapDocumentJson): string[] {
  const ids: string[] = []
  collect(document)
  return ids

  function collect(node: TiptapDocumentJson | NonNullable<TiptapDocumentJson['content']>[number]): void {
    const id = node.attrs?.id
    if (typeof id === 'string') ids.push(id)
    node.content?.forEach((child) => collect(child))
  }
}
