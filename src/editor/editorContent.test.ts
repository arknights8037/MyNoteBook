import { describe, expect, it } from 'vitest'

import {
  isSameEditorContent,
  normalizeEditorContent,
  parseEditorContentJson,
  serializeEditorContent,
} from './editorContent'
import { EMPTY_TIPTAP_DOCUMENT, type TiptapDocumentJson } from '@/models/document'
import { isValidNodeId, validateDocumentNodeIds } from './blockId'

describe('editorContent', () => {
  it('normalizes empty input to a cloned empty document', () => {
    const normalized = normalizeEditorContent(undefined)

    expect(normalized.type).toBe(EMPTY_TIPTAP_DOCUMENT.type)
    expect(normalized.content?.[0]?.type).toBe('paragraph')
    expect(isValidNodeId(normalized.attrs?.id)).toBe(true)
    expect(isValidNodeId(normalized.content?.[0]?.attrs?.id)).toBe(true)
    expect(validateDocumentNodeIds(normalized).valid).toBe(true)
    expect(normalized).not.toBe(EMPTY_TIPTAP_DOCUMENT)
  })

  it('parses and serializes Tiptap document JSON', () => {
    const document: TiptapDocumentJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    }

    const serialized = serializeEditorContent(document)
    const normalized = JSON.parse(serialized) as TiptapDocumentJson

    expect(parseEditorContentJson(serialized)).toEqual(normalized)
    expect(validateDocumentNodeIds(normalized).valid).toBe(true)
  })

  it('detects equivalent document content', () => {
    const left = normalizeEditorContent(undefined)
    const right = JSON.parse(JSON.stringify(left)) as TiptapDocumentJson

    expect(isSameEditorContent(left, right)).toBe(true)
  })

  it('throws for invalid persisted content', () => {
    expect(() => parseEditorContentJson('{"type":"paragraph"}')).toThrow(
      'Invalid Tiptap document JSON.',
    )
  })
})
