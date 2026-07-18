import { createEntityId } from '@/models/id'
import { GeneratedViewAiExecutor } from '@/services/GeneratedViewAiExecutor'
import { KnowledgeControlService } from '@/services/KnowledgeControlService'
import { tauriCliAgentFilePort } from '@/infrastructure/transfer/tauriCliAgentFilePort'
import { createDocumentRepository } from '@/infrastructure/database/documentRepositoryFactory'
import { createGovernanceRepository } from '@/infrastructure/database/governanceRepositoryFactory'
import { createKnowledgeRepository } from '@/infrastructure/database/knowledgeRepositoryFactory'
import { createViewRepository } from '@/infrastructure/database/viewRepositoryFactory'
import { createWorkRepository } from '@/infrastructure/database/workRepositoryFactory'
import { assetService } from '@/infrastructure/assets/AssetService'

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
    assetService,
  )
}
