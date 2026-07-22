import { createDocumentRepository } from '@/infrastructure/database/documents/documentRepositoryFactory'
import { createKnowledgeRepository } from '@/infrastructure/database/knowledge/knowledgeRepositoryFactory'
import { ResearchCandidateService } from '@/services/cognitive/ResearchCandidateService'

export async function createResearchCandidateService(
  createId: (prefix: string) => string,
): Promise<ResearchCandidateService> {
  const [knowledge, documents] = await Promise.all([
    createKnowledgeRepository(),
    createDocumentRepository(),
  ])
  return new ResearchCandidateService(knowledge, documents, createId)
}
