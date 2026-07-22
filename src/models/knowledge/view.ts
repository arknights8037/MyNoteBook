export type ViewType = 'query' | 'projection' | 'generated'
export type ViewWritebackPolicy = 'readonly' | 'propose_changeset' | 'fork_document'

export interface ViewGenerationConfig {
  prompt: string
  provider: string
  model: string
  skillVersions: Array<{ id: string; version: string | null }>
}

export interface ViewDefinition {
  id: string
  name: string
  viewType: ViewType
  scopeQuery: Record<string, unknown>
  projectionSchema: Record<string, unknown> | null
  renderSpec: Record<string, unknown>
  refreshPolicy: 'manual'
  writebackPolicy: ViewWritebackPolicy
  targetDocumentId: string | null
  generation: ViewGenerationConfig | null
  manualOverride: boolean
  overrideContent: unknown
  overrideUpdatedAt: number | null
  stale: boolean
  version: number
  currentSnapshotId: string | null
  lastRefreshedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface ViewDependency {
  sourceType: 'knowledge_object' | 'document_block'
  knowledgeObjectId: string | null
  documentId: string | null
  blockId: string | null
  sourceRevision: number
}

export interface ViewSnapshot {
  id: string
  viewId: string
  status: 'fresh' | 'stale' | 'failed' | 'preview'
  sourceSnapshotHash: string
  render: unknown
  provider: string | null
  model: string | null
  skillVersions: Array<{ id: string; version: string | null }>
  generatedAt: number | null
  protectedByOverride: boolean
  correlationId: string | null
  causationId: string | null
  error: string | null
  createdAt: number
}
