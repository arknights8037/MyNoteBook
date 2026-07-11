import { computed, ref } from 'vue'

import type { WorkspaceSurface } from '@/pages/DocumentSidebar.vue'

export function useWorkspaceSurface() {
  const showAiChat = ref(true)
  const aiChatFullscreen = ref(true)
  const showSettings = ref(false)
  const showPluginSkills = ref(false)

  const activeSurface = computed<WorkspaceSurface>(() => {
    if (showSettings.value) return 'settings'
    if (showPluginSkills.value) return 'plugins'
    if (showAiChat.value && aiChatFullscreen.value) return 'agent'
    return 'document'
  })

  function openAgentWorkspace(): void {
    showSettings.value = false
    showPluginSkills.value = false
    showAiChat.value = true
    aiChatFullscreen.value = true
  }

  function openSettingsSurface(): void {
    showPluginSkills.value = false
    showAiChat.value = false
    aiChatFullscreen.value = false
    showSettings.value = true
  }

  function openPluginSkillsSurface(): void {
    showSettings.value = false
    showAiChat.value = false
    aiChatFullscreen.value = false
    showPluginSkills.value = true
  }

  function openDocumentSurface(): void {
    showSettings.value = false
    showPluginSkills.value = false
    showAiChat.value = false
    aiChatFullscreen.value = false
  }

  function closeAiChat(): void {
    showAiChat.value = false
    aiChatFullscreen.value = false
  }

  function setAiChatWorkspace(workspace: boolean): void {
    showAiChat.value = true
    aiChatFullscreen.value = workspace
    if (workspace) {
      showSettings.value = false
      showPluginSkills.value = false
    }
  }

  return {
    showAiChat,
    aiChatFullscreen,
    showSettings,
    showPluginSkills,
    activeSurface,
    openAgentWorkspace,
    openSettingsSurface,
    openPluginSkillsSurface,
    openDocumentSurface,
    closeAiChat,
    setAiChatWorkspace,
  }
}
