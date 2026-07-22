import type { AiChatMode, AiChatRole, AiChatStatus } from '@/models/ai/aiChatMode'
import type { DocumentId, DocumentKind, TiptapDocumentJson } from '@/models/documents/document'
import type { KnowledgeSource } from '@/models/knowledge/knowledgeRetrieval'
import type { SelectedBlock } from '@/models/agent/agent'

export interface EditorShellExpose {
  getJSON: () => TiptapDocumentJson | undefined
  getText: () => string
  getDocumentMarkdown: () => string
  getCurrentDocumentBlocks: () => SelectedBlock[]
  getSelectedBlocks: () => SelectedBlock[]
  hasBlockSelection: () => boolean
  insertImage: () => void
  insertAttachment: () => void
  insertMarkdown: (markdown: string) => void
  replaceBlocksWithMarkdown: (blockIds: string[], markdown: string) => boolean
  revealBlock: (blockId: string) => boolean
  undo: () => void
}

export interface CreateDocumentOptions {
  parentId?: DocumentId | null
  documentKind?: DocumentKind
  content?: TiptapDocumentJson
  plainText?: string
  sourceUrl?: string
}

export interface DocumentSidebarExpose {
  openFilePicker: () => void
}

export interface MarkdownFileInput {
  files?: MarkdownFileList | null
  value: string
  click: () => void
}

interface MarkdownFileList {
  readonly length: number
  [index: number]: MarkdownFile
}

interface MarkdownFile {
  name: string
  path?: string
  webkitRelativePath?: string
  text: () => Promise<string>
}

export interface AiChatMessage {
  id: string
  role: AiChatRole
  mode: AiChatMode
  content: string
  reasoningContent?: string
  sources?: KnowledgeSource[]
  status: AiChatStatus
}
