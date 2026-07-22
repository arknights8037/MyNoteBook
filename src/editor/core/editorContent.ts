import { EMPTY_TIPTAP_DOCUMENT, type TiptapDocumentJson } from '@/models/documents/document'
import { normalizeDocumentNodeIds } from '@/editor/blocks/blockId'

export function cloneEditorContent(content: TiptapDocumentJson): TiptapDocumentJson {
  return JSON.parse(JSON.stringify(content)) as TiptapDocumentJson
}

export function parseEditorContentJson(contentJson: string): TiptapDocumentJson {
  try {
    const parsed = JSON.parse(contentJson) as unknown

    if (isTiptapDocumentJson(parsed)) {
      return normalizeDocumentNodeIds(parsed)
    }

    throw new Error('Parsed content is not a Tiptap document.')
  } catch (error) {
    throw new Error('Invalid Tiptap document JSON.', { cause: error })
  }
}

export function serializeEditorContent(content: TiptapDocumentJson): string {
  return JSON.stringify(normalizeDocumentNodeIds(content))
}

export function normalizeEditorContent(
  content: TiptapDocumentJson | null | undefined,
): TiptapDocumentJson {
  return normalizeDocumentNodeIds(cloneEditorContent(content ?? EMPTY_TIPTAP_DOCUMENT))
}

export function isSameEditorContent(
  left: TiptapDocumentJson,
  right: TiptapDocumentJson,
): boolean {
  return serializeEditorContent(left) === serializeEditorContent(right)
}

function isTiptapDocumentJson(value: unknown): value is TiptapDocumentJson {
  if (!isRecord(value)) {
    return false
  }

  return value.type === 'doc'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
