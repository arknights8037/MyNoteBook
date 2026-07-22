import type { AppResult } from '@/models/shared/result'
import type {
  ViewDefinition,
  ViewDependency,
  ViewGenerationConfig,
  ViewSnapshot,
  ViewType,
  ViewWritebackPolicy,
} from '@/models/knowledge/view'

export interface ViewRepository {
  createDefinition(input: {
    id: string
    name: string
    viewType: ViewType
    scopeQuery: Record<string, unknown>
    projectionSchema?: Record<string, unknown> | null
    renderSpec?: Record<string, unknown>
    writebackPolicy: ViewWritebackPolicy
    targetDocumentId?: string | null
    generation?: ViewGenerationConfig | null
    createdAt?: number
  }): Promise<AppResult<ViewDefinition>>
  getDefinition(id: string): Promise<AppResult<ViewDefinition>>
  listDefinitions(): Promise<AppResult<ViewDefinition[]>>
  getLatestSnapshot(viewId: string): Promise<AppResult<ViewSnapshot | null>>
  commitRefresh(input: {
    definition: ViewDefinition
    snapshot: ViewSnapshot
    dependencies: ViewDependency[]
  }): Promise<AppResult<ViewSnapshot>>
  setManualOverride(input: {
    viewId: string
    expectedVersion: number
    content: unknown
    correlationId: string
    updatedAt: number
  }): Promise<AppResult<ViewDefinition>>
}
