<script setup lang="ts">
import {
  createAuditRepositoryProvider,
  createAutomationServiceProvider,
  createDocumentService,
  createDocumentTransferServiceProvider,
  createMcpClient,
  tauriDataDirectoryPort,
  tauriRegexReplaceExecutor,
} from '@/app/composition/surfaceServiceProviders'
import { createKnowledgeControlService } from '@/app/composition/knowledgeControlServiceFactory'
import { createWorkspaceServiceProviders } from '@/app/composition/workspaceServiceProviders'
import { createAgentCommunicationServiceProvider } from '@/app/composition/agentCommunicationServiceFactory'
import WorkspaceSurface from '@/features/workspace/components/WorkspaceSurface.vue'

const getAuditRepository = createAuditRepositoryProvider()
const getAutomationService = createAutomationServiceProvider()
const getDocumentTransferService = createDocumentTransferServiceProvider()
let knowledgeControlService: ReturnType<typeof createKnowledgeControlService> | null = null
const getKnowledgeControlService = () =>
  (knowledgeControlService ??= createKnowledgeControlService())
const mcpClient = createMcpClient()
const workspaceServices = createWorkspaceServiceProviders(mcpClient)
const getAgentCommunicationService = createAgentCommunicationServiceProvider()
</script>

<template>
  <WorkspaceSurface
    :create-document-service="createDocumentService"
    :get-document-transfer-service="getDocumentTransferService"
    :get-audit-repository="getAuditRepository"
    :get-automation-service="getAutomationService"
    :get-knowledge-control-service="getKnowledgeControlService"
    :replace-blocks-by-regex="tauriRegexReplaceExecutor"
    :agent-run-services="workspaceServices"
    :get-workspace-view-service="workspaceServices.getWorkspaceViewService"
    :get-agent-communication-service="getAgentCommunicationService"
    :data-directory-port="tauriDataDirectoryPort"
  />
</template>
