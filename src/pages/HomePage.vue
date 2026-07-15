<script setup lang="ts">
import {
  createAuditRepositoryProvider,
  createAutomationServiceProvider,
  createDocumentService,
  createDocumentTransferServiceProvider,
  tauriRegexReplaceExecutor,
} from '@/app/composition/surfaceServiceProviders'
import { createKnowledgeControlService } from '@/app/composition/knowledgeControlServiceFactory'
import WorkspaceSurface from '@/features/workspace/components/WorkspaceSurface.vue'

const getAuditRepository = createAuditRepositoryProvider()
const getAutomationService = createAutomationServiceProvider()
const getDocumentTransferService = createDocumentTransferServiceProvider()
let knowledgeControlService: ReturnType<typeof createKnowledgeControlService> | null = null
const getKnowledgeControlService = () =>
  (knowledgeControlService ??= createKnowledgeControlService())
</script>

<template>
  <WorkspaceSurface
    :create-document-service="createDocumentService"
    :get-document-transfer-service="getDocumentTransferService"
    :get-audit-repository="getAuditRepository"
    :get-automation-service="getAutomationService"
    :get-knowledge-control-service="getKnowledgeControlService"
    :replace-blocks-by-regex="tauriRegexReplaceExecutor"
  />
</template>
