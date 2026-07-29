import type { Editor } from '@tiptap/vue-3'
import { ref, type Ref } from 'vue'

import { createAssetUrl } from '@/models/documents/asset'
import { requireAssetPort, type AssetPort } from '@/services/ports/AssetPort'

interface UseEditorAssetInsertionOptions {
  editor: Readonly<Ref<Editor | null | undefined>>
  assetPort: AssetPort | null
  documentId: () => string
  reportError: (message: string) => void
}

export function useEditorAssetInsertion(options: UseEditorAssetInsertionOptions) {
  const imageFileInput = ref<HTMLInputElement | null>(null)
  const attachmentFileInput = ref<HTMLInputElement | null>(null)
  const pendingImagePosition = ref<number | null>(null)
  const pendingAttachmentPosition = ref<number | null>(null)

  function insertImage(): void {
    const activeEditor = options.editor.value
    if (!activeEditor?.isEditable) return
    pendingImagePosition.value = activeEditor.state.selection.from
    imageFileInput.value?.click()
  }

  function insertAttachment(): void {
    const activeEditor = options.editor.value
    if (!activeEditor?.isEditable) return
    pendingAttachmentPosition.value = activeEditor.state.selection.from
    attachmentFileInput.value?.click()
  }

  async function handleImageFileChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    await insertImageFile(file, pendingImagePosition.value ?? undefined)
    pendingImagePosition.value = null
  }

  async function handleAttachmentFileChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    await insertAttachmentFile(file, pendingAttachmentPosition.value ?? undefined)
    pendingAttachmentPosition.value = null
  }

  async function insertImageFile(file: File, requestedPosition?: number): Promise<void> {
    const activeEditor = options.editor.value
    if (!activeEditor?.isEditable) return

    try {
      const asset = await requireAssetPort(options.assetPort).storeFile(
        file,
        options.documentId() || null,
      )
      const position = clampEditorPosition(activeEditor, requestedPosition)
      activeEditor
        .chain()
        .focus()
        .insertContentAt(position, [
          {
            type: 'imageFigure',
            attrs: { src: createAssetUrl(asset.id), alt: file.name, originalName: file.name },
          },
          { type: 'paragraph' },
        ])
        .run()
    } catch (error) {
      options.reportError(error instanceof Error ? error.message : '无法读取图片')
    }
  }

  async function insertAttachmentFile(file: File, requestedPosition?: number): Promise<void> {
    const activeEditor = options.editor.value
    if (!activeEditor?.isEditable) return

    try {
      const asset = await requireAssetPort(options.assetPort).storeFile(
        file,
        options.documentId() || null,
      )
      const position = clampEditorPosition(activeEditor, requestedPosition)
      activeEditor
        .chain()
        .focus()
        .insertContentAt(position, [
          {
            type: 'attachmentBlock',
            attrs: {
              assetId: asset.id,
              name: asset.originalName,
              mimeType: asset.mimeType,
              sizeBytes: asset.sizeBytes,
            },
          },
          { type: 'paragraph' },
        ])
        .run()
    } catch (error) {
      options.reportError(error instanceof Error ? error.message : '无法保存附件')
    }
  }

  return {
    imageFileInput,
    attachmentFileInput,
    insertImage,
    insertAttachment,
    handleImageFileChange,
    handleAttachmentFileChange,
    insertImageFile,
    insertAttachmentFile,
  }
}

export function getClipboardImageFile(event: ClipboardEvent): File | null {
  const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
    item.type.startsWith('image/'),
  )
  if (file) return file

  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const clipboardFile = item.getAsFile()
    if (clipboardFile) return clipboardFile
  }
  return null
}

function clampEditorPosition(editor: Editor, requestedPosition?: number): number {
  return Math.max(
    0,
    Math.min(requestedPosition ?? editor.state.selection.from, editor.state.doc.content.size),
  )
}
