import { computed, ref } from 'vue'

import type { WorkspaceSurface } from '@/models/workspace/workspaceSurface'

type AiPanelMode = 'closed' | 'docked' | 'workspace'
type PrimarySurface = Exclude<WorkspaceSurface, 'agent'>

export function useWorkspaceSurface() {
  const primarySurface = ref<PrimarySurface>('document')
  const aiPanelMode = ref<AiPanelMode>('workspace')

  const showAiChat = computed(() => aiPanelMode.value !== 'closed')
  const aiChatFullscreen = computed(() => aiPanelMode.value === 'workspace')
  const showSettings = computed(() => primarySurface.value === 'settings')
  const showPluginSkills = computed(() => primarySurface.value === 'plugins')
  const showAutomations = computed(() => primarySurface.value === 'automations')
  const showAudit = computed(() => primarySurface.value === 'audit')
  const showKnowledgeControl = computed(() => primarySurface.value === 'knowledge')
  const activeSurface = computed<WorkspaceSurface>(() =>
    aiPanelMode.value === 'workspace' ? 'agent' : primarySurface.value,
  )

  function openPrimarySurface(surface: PrimarySurface): void {
    primarySurface.value = surface
    aiPanelMode.value = 'closed'
  }

  function openAgentWorkspace(): void {
    primarySurface.value = 'document'
    aiPanelMode.value = 'workspace'
  }

  function openSettingsSurface(): void {
    openPrimarySurface('settings')
  }

  function openPluginSkillsSurface(): void {
    openPrimarySurface('plugins')
  }

  function openAutomationsSurface(): void {
    openPrimarySurface('automations')
  }

  function openAuditSurface(): void {
    openPrimarySurface('audit')
  }

  function openKnowledgeControlSurface(): void {
    openPrimarySurface('knowledge')
  }

  function openDocumentSurface(): void {
    openPrimarySurface('document')
  }

  function closeAiChat(): void {
    if (aiPanelMode.value === 'workspace') primarySurface.value = 'document'
    aiPanelMode.value = 'closed'
  }

  function setAiChatWorkspace(workspace: boolean): void {
    if (workspace) {
      primarySurface.value = 'document'
      aiPanelMode.value = 'workspace'
      return
    }
    if (activeSurface.value === 'agent') primarySurface.value = 'document'
    aiPanelMode.value = 'docked'
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
