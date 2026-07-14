<script setup lang="ts">
import SettingsSurface from '@/features/settings/components/SettingsSurface.vue'
import type { AiSettings } from '@/models/ai'
import type { AppSettings } from '@/models/settings'

defineProps<{
  settings: AppSettings
  aiSettings?: AiSettings
  defaultDataDirectory?: string
  dataBusy?: boolean
}>()

const emit = defineEmits<{
  close: []
  reset: []
  change: [settings: AppSettings]
  aiChange: [settings: AiSettings]
  aiSectionOpen: []
  chooseDataDirectory: []
  restoreDataDirectory: []
}>()
</script>

<template>
  <SettingsSurface
    :settings="settings"
    :ai-settings="aiSettings"
    :default-data-directory="defaultDataDirectory"
    :data-busy="dataBusy"
    @close="emit('close')"
    @reset="emit('reset')"
    @change="emit('change', $event)"
    @ai-change="emit('aiChange', $event)"
    @ai-section-open="emit('aiSectionOpen')"
    @choose-data-directory="emit('chooseDataDirectory')"
    @restore-data-directory="emit('restoreDataDirectory')"
  />
</template>
