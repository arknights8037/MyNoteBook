<script setup lang="ts">
import { createAutomationServiceProvider } from '@/app/composition/surfaceServiceProviders'
import AutomationSurface from '@/features/automation/components/AutomationSurface.vue'

defineProps<{
  currentDocumentId: string
  currentDocumentTitle: string
}>()

const getService = createAutomationServiceProvider()
</script>

<template>
  <AutomationSurface
    :current-document-id="currentDocumentId"
    :current-document-title="currentDocumentTitle"
    :get-service="getService"
  />
</template>
