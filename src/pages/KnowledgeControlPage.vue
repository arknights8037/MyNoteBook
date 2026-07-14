<script setup lang="ts">
import { createKnowledgeControlService } from '@/app/composition/knowledgeControlServiceFactory'
import KnowledgeControlSurface from '@/features/knowledge-control/components/KnowledgeControlSurface.vue'

defineProps<{
  currentDocumentId: string
  currentDocumentRevision: number
}>()

let service: ReturnType<typeof createKnowledgeControlService> | null = null
const getService = () => (service ??= createKnowledgeControlService())
</script>

<template>
  <KnowledgeControlSurface
    :current-document-id="currentDocumentId"
    :current-document-revision="currentDocumentRevision"
    :get-service="getService"
  />
</template>
