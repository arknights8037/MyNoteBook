import type {
  DocumentId,
  DocumentKind,
  DocumentSummary,
  TiptapDocumentJson,
} from '@/models/document'

export interface DocumentWorkspaceSettings {
  autosaveDelay: number
  confirmBeforeDelete: boolean
  startupBehavior: 'last' | 'first' | string
}

export interface DocumentWorkspaceEditor {
  getJSON: () => TiptapDocumentJson | undefined
  getText: () => string
}

export interface CreateWorkspaceDocumentOptions {
  parentId?: DocumentId | null
  documentKind?: DocumentKind
  content?: TiptapDocumentJson
  plainText?: string
  sourceUrl?: string
}

export interface DocumentWorkspaceNotifier {
  success: (message: string) => void
  error: (message: string) => void
}

export interface DocumentWorkspaceConfirmation {
  (document: DocumentSummary, descendantCount: number, permanent: boolean): Promise<boolean>
}
