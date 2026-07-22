import { createAuditRepository } from '@/infrastructure/database/audit/auditRepositoryFactory'
import { createAutomationRepository } from '@/infrastructure/database/automation/automationRepositoryFactory'
import { createDocumentRepository } from '@/infrastructure/database/documents/documentRepositoryFactory'
import { tauriDocumentTransferFilePort } from '@/infrastructure/transfer/tauriDocumentTransferFilePort'
import { createEntityId } from '@/models/shared/id'
import type { AuditRepository } from '@/repositories/audit/AuditRepository'
import { AutomationService } from '@/services/automation/AutomationService'
import { DocumentService } from '@/services/documents/DocumentService'
import { DocumentTransferService } from '@/services/documents/DocumentTransferService'
import type { SelectedBlock } from '@/models/agent/agent'
import type { RegexReplaceExecutor } from '@/services/agent/AgentCommandService'
import { executeRustAgentTool } from '@/services/agent/RustAgentToolService'
import { tauriAssetService } from '@/infrastructure/assets/AssetService'
import { getDefaultDataDirectory } from '@/infrastructure/database/shared/dataDirectory'
export { tauriDataDirectoryPort } from '@/infrastructure/database/shared/TauriDataDirectoryPort'
import { TauriMcpClient } from '@/infrastructure/integrations/TauriMcpClient'
import { loadAppSettings } from '@/models/settings/settings'
import type { McpClientPort } from '@/services/ports/McpClientPort'

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
    (service ??= Promise.resolve(
      new DocumentTransferService(tauriDocumentTransferFilePort, undefined, tauriAssetService),
    ))
}

export function createMcpClient(): McpClientPort {
  return new TauriMcpClient(async () =>
    Promise.resolve(loadAppSettings().dataDirectory ?? getDefaultDataDirectory()),
  )
}

export const tauriRegexReplaceExecutor: RegexReplaceExecutor = async (input) => {
  const result = await executeRustAgentTool('replace_blocks_by_regex', input)
  if (!Array.isArray(result)) throw new Error('安全正则替换器返回了无效结果。')
  return result as SelectedBlock[]
}
