import { createEntityId } from '@/models/shared/id'
import { GeneratedViewAiExecutor } from '@/services/workspace/GeneratedViewAiExecutor'
import { KnowledgeControlService } from '@/services/knowledge/KnowledgeControlService'
import { tauriCliAgentFilePort } from '@/infrastructure/transfer/tauriCliAgentFilePort'
import { createDocumentRepository } from '@/infrastructure/database/documents/documentRepositoryFactory'
import { createGovernanceRepository } from '@/infrastructure/database/knowledge/governanceRepositoryFactory'
import { createKnowledgeRepository } from '@/infrastructure/database/knowledge/knowledgeRepositoryFactory'
import { createViewRepository } from '@/infrastructure/database/knowledge/viewRepositoryFactory'
import { createWorkRepository } from '@/infrastructure/database/knowledge/workRepositoryFactory'
import { tauriAssetService } from '@/infrastructure/assets/AssetService'

export async function createKnowledgeControlService(): Promise<KnowledgeControlService> {
  const [knowledge, views, work, documents, governance] = await Promise.all([
    createKnowledgeRepository(),
    createViewRepository(),
    createWorkRepository(),
    createDocumentRepository(),
    createGovernanceRepository(),
  ])
  return new KnowledgeControlService(
    knowledge,
    views,
    work,
    documents,
    governance,
    tauriCliAgentFilePort,
    createEntityId,
    Date.now,
    new GeneratedViewAiExecutor(),
    tauriAssetService,
  )
}
