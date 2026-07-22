<script setup lang="ts">
import { createMcpClient } from '@/app/composition/surfaceServiceProviders'
import PluginSkillsSurface from '@/features/integrations/skills/components/PluginSkillsSurface.vue'

const mcpClient = createMcpClient()
</script>

<template>
  <PluginSkillsSurface :mcp-client="mcpClient" />
</template>
