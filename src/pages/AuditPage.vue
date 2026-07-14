<script setup lang="ts">
import { createAuditRepositoryProvider } from '@/app/composition/surfaceServiceProviders'
import AuditSurface from '@/features/audit/components/AuditSurface.vue'

const getRepository = createAuditRepositoryProvider()
</script>

<template>
  <AuditSurface :get-repository="getRepository" />
</template>
