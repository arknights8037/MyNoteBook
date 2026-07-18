import type { KnowledgeObject } from './knowledge'

export type KnowledgeAssetSourceType = 'office_file' | 'text_file' | 'ai_chat'

export interface KnowledgeAsset {
  id: string
  title: string
  sourceType: KnowledgeAssetSourceType
  format: string
  documentId: string | null
  assetId: string | null
  originalName: string
  mimeType: string
  sizeBytes: number
  characterCount: number
  provider: string
  model: string
  conversationId: string
  messageCount: number
  importBatchId: string
  importBatchName: string
  archivePath: string
  importedFromArchive: boolean
  processingStatus: string
  content: string
  createdAt: number
  updatedAt: number
}

export function isKnowledgeAssetObject(object: KnowledgeObject): boolean {
  return object.structuredData?.kind === 'document_asset'
}

export function knowledgeAssetFromObject(object: KnowledgeObject): KnowledgeAsset | null {
  if (!isKnowledgeAssetObject(object)) return null
  const data = object.structuredData
  const sourceType = data.sourceType
  if (sourceType !== 'office_file' && sourceType !== 'text_file' && sourceType !== 'ai_chat') {
    return null
  }
  return {
    id: object.id,
    title: object.title,
    sourceType,
    format: stringValue(data.format),
    documentId: object.documentId,
    assetId: stringValue(data.assetId) || null,
    originalName: stringValue(data.originalName),
    mimeType: stringValue(data.mimeType),
    sizeBytes: numberValue(data.sizeBytes),
    characterCount: numberValue(data.characterCount),
    provider: stringValue(data.provider),
    model: stringValue(data.model),
    conversationId: stringValue(data.conversationId),
    messageCount: numberValue(data.messageCount),
    importBatchId: stringValue(data.importBatchId),
    importBatchName: stringValue(data.importBatchName),
    archivePath: stringValue(data.archivePath),
    importedFromArchive: data.importedFromArchive === true,
    processingStatus: stringValue(data.processingStatus) || 'pending',
    content: object.content,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
