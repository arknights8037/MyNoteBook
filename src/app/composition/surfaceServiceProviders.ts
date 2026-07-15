import { createAuditRepository } from '@/infrastructure/database/auditRepositoryFactory'
import { createAutomationRepository } from '@/infrastructure/database/automationRepositoryFactory'
import { createDocumentRepository } from '@/infrastructure/database/documentRepositoryFactory'
import { tauriDocumentTransferFilePort } from '@/infrastructure/transfer/tauriDocumentTransferFilePort'
import { createEntityId } from '@/models/id'
import type { AuditRepository } from '@/repositories/AuditRepository'
import { AutomationService } from '@/services/AutomationService'
import { DocumentService } from '@/services/DocumentService'
import { DocumentTransferService } from '@/services/DocumentTransferService'
import type { SelectedBlock } from '@/models/agent'
import type { RegexReplaceExecutor } from '@/services/AgentCommandService'
import { executeRustAgentTool } from '@/services/RustAgentToolService'

export function createAuditRepositoryProvider(): () => Promise<AuditRepository> {
  let repository: Promise<AuditRepository> | null = null
  return () => (repository ??= createAuditRepository())
}

export function createAutomationServiceProvider(): () => Promise<AutomationService> {
  let service: Promise<AutomationService> | null = null
  return () =>
    (service ??= createAutomationRepository().then(
      (repository) => new AutomationService(repository, createEntityId),
    ))
}

export async function createDocumentService(): Promise<DocumentService> {
  return new DocumentService(await createDocumentRepository())
}

export function createDocumentTransferServiceProvider(): () => Promise<DocumentTransferService> {
  let service: Promise<DocumentTransferService> | null = null
  return () =>
    (service ??= Promise.resolve(new DocumentTransferService(tauriDocumentTransferFilePort)))
}

export const tauriRegexReplaceExecutor: RegexReplaceExecutor = async (input) => {
  const result = await executeRustAgentTool('replace_blocks_by_regex', input)
  if (!Array.isArray(result)) throw new Error('安全正则替换器返回了无效结果。')
  return result as SelectedBlock[]
}
