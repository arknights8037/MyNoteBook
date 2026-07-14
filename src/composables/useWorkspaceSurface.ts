import { computed, ref } from 'vue'

import type { WorkspaceSurface } from '@/features/documents/components/DocumentSidebar.vue'

export function useWorkspaceSurface() {
  const showAiChat = ref(true)
  const aiChatFullscreen = ref(true)
  const showSettings = ref(false)
  const showPluginSkills = ref(false)
  const showAutomations = ref(false)
  const showAudit = ref(false)
  const showKnowledgeControl = ref(false)

  const activeSurface = computed<WorkspaceSurface>(() => {
    if (showSettings.value) return 'settings'
    if (showPluginSkills.value) return 'plugins'
    if (showAutomations.value) return 'automations'
    if (showAudit.value) return 'audit'
    if (showKnowledgeControl.value) return 'knowledge'
    if (showAiChat.value && aiChatFullscreen.value) return 'agent'
    return 'document'
  })

  function openAgentWorkspace(): void {
    showSettings.value = false
    showPluginSkills.value = false
    showAutomations.value = false
    showAudit.value = false
    showKnowledgeControl.value = false
    showAiChat.value = true
    aiChatFullscreen.value = true
  }

  function openSettingsSurface(): void {
    showPluginSkills.value = false
    showAutomations.value = false
    showAudit.value = false
    showKnowledgeControl.value = false
    showAiChat.value = false
    aiChatFullscreen.value = false
    showSettings.value = true
  }

  function openPluginSkillsSurface(): void {
    showSettings.value = false
    showAutomations.value = false
    showAudit.value = false
    showKnowledgeControl.value = false
    showAiChat.value = false
    aiChatFullscreen.value = false
    showPluginSkills.value = true
  }

  function openAutomationsSurface(): void {
    showSettings.value = false
    showPluginSkills.value = false
    showAudit.value = false
    showKnowledgeControl.value = false
    showAiChat.value = false
    aiChatFullscreen.value = false
    showAutomations.value = true
  }

  function openAuditSurface(): void {
    showSettings.value = false
    showPluginSkills.value = false
    showAutomations.value = false
    showAiChat.value = false
    aiChatFullscreen.value = false
    showAudit.value = true
    showKnowledgeControl.value = false
  }

  function openKnowledgeControlSurface(): void {
    showSettings.value = false
    showPluginSkills.value = false
    showAutomations.value = false
    showAudit.value = false
    showAiChat.value = false
    aiChatFullscreen.value = false
    showKnowledgeControl.value = true
  }

  function openDocumentSurface(): void {
    showSettings.value = false
    showPluginSkills.value = false
    showAutomations.value = false
    showAudit.value = false
    showKnowledgeControl.value = false
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
      showAutomations.value = false
      showAudit.value = false
      showKnowledgeControl.value = false
    }
  }

  return {
    showAiChat,
    aiChatFullscreen,
    showSettings,
    showPluginSkills,
    showAutomations,
    showAudit,
    showKnowledgeControl,
    activeSurface,
    openAgentWorkspace,
    openSettingsSurface,
    openPluginSkillsSurface,
    openAutomationsSurface,
    openAuditSurface,
    openKnowledgeControlSurface,
    openDocumentSurface,
    closeAiChat,
    setAiChatWorkspace,
  }
}
