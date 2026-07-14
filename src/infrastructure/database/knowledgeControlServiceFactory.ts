import { createEntityId } from '@/models/id'
import { GeneratedViewAiExecutor } from '@/services/GeneratedViewAiExecutor'
import { KnowledgeControlService } from '@/services/KnowledgeControlService'
import { tauriCliAgentFilePort } from '@/infrastructure/transfer/tauriCliAgentFilePort'
import { createDocumentRepository } from './documentRepositoryFactory'
import { createGovernanceRepository } from './governanceRepositoryFactory'
import { createKnowledgeRepository } from './knowledgeRepositoryFactory'
import { createViewRepository } from './viewRepositoryFactory'
import { createWorkRepository } from './workRepositoryFactory'

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
  )
}
