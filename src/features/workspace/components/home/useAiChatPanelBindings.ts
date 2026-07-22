import { computed, type Ref } from 'vue'

import type { useAiConversation } from '@/composables/useAiConversation'
import type { useAiPreferences } from '@/composables/useAiPreferences'
import type { useWorkspaceSurface } from '@/composables/useWorkspaceSurface'
import type { AgentTask } from '@/models/agent/agent'
import type { AgentRuntimeState } from '@/models/agent/agentRuntime'
import type { AgentExplicitTarget, AgentTargetOption } from '@/models/agent/agentTarget'
import { AI_PROVIDER_CONFIGS } from '@/models/ai/ai'
import { AI_MODE_OPTIONS } from '@/models/ai/aiChatMode'
import type { DocumentId } from '@/models/documents/document'
import type { renderAiMarkdown } from '@/services/ai/AiMarkdownRenderer'
import type { useHomeAiMessageActions } from './useHomeAiMessageActions'
import type { useResearchReviewActions } from './useResearchReviewActions'

interface AiChatPanelBindingsOptions {
  preferences: ReturnType<typeof useAiPreferences>
  conversation: ReturnType<typeof useAiConversation>
  surface: ReturnType<typeof useWorkspaceSurface>
  homeActions: ReturnType<typeof useHomeAiMessageActions>
  researchActions: ReturnType<typeof useResearchReviewActions>
  prompt: Ref<string>
  error: Readonly<Ref<string>>
  isRunning: Readonly<Ref<boolean>>
  activeTask: Readonly<Ref<AgentTask | null>>
  runtimeState: Readonly<Ref<AgentRuntimeState>>
  workspaceOptions: Readonly<Ref<AgentTargetOption[]>>
  currentWorkspaceRootIds: Readonly<Ref<string[]>>
  currentDocumentTitle: Readonly<Ref<string>>
  knowledgeSourceCount: Readonly<Ref<number>>
  targetOptions: Readonly<Ref<AgentTargetOption[]>>
  explicitTargets: Ref<AgentExplicitTarget[]>
  renderMarkdown: typeof renderAiMarkdown
  run: () => Promise<void>
  stop: () => void
  clear: () => void
  selectTarget: (target: AgentTargetOption) => void
  clearTarget: (targetId: string) => void
  writeMessageToChildDocument: (messageId: string) => Promise<DocumentId | null | void>
}

export function useAiChatPanelBindings(options: AiChatPanelBindingsOptions) {
  const { preferences, conversation, surface, homeActions, researchActions } = options
  return computed(() => ({
    prompt: options.prompt.value,
    mode: preferences.aiChatMode.value,
    modeLabel: preferences.aiModeLabel.value,
    modeOptions: AI_MODE_OPTIONS,
    providerLabel: preferences.aiProviderLabel.value,
    providerOptions: AI_PROVIDER_CONFIGS,
    reasoningLabel: preferences.aiReasoningLabel.value,
    reasoningOptions: preferences.reasoningOptions,
    modelOptions: preferences.aiModelOptions.value,
    settings: preferences.aiSettings.value,
    messages: conversation.messages.value,
    chatHistory: conversation.history.value,
    currentHistoryId: conversation.currentHistoryId.value,
    projects: conversation.projects.value,
    currentProjectId: conversation.activeProjectId.value,
    workspaceOptions: options.workspaceOptions.value,
    currentWorkspaceRootIds: options.currentWorkspaceRootIds.value,
    currentDocumentTitle: options.currentDocumentTitle.value,
    knowledgeSourceCount: options.knowledgeSourceCount.value,
    promptPlaceholder: preferences.aiPromptPlaceholder.value,
    error: options.error.value,
    isRunning: options.isRunning.value,
    agentStep: options.activeTask.value?.currentStep ?? '',
    runtimeState: options.runtimeState.value,
    renderMarkdownMessage: options.renderMarkdown,
    targetOptions: options.targetOptions.value,
    explicitTargets: options.explicitTargets.value,
    'onUpdate:prompt': (value: string) => {
      options.prompt.value = value
    },
    onSelectMode: preferences.selectAiMode,
    onSelectProvider: preferences.selectAiProvider,
    onSelectModel: preferences.selectAiModel,
    onSelectReasoning: preferences.selectAiReasoning,
    onToggleWorkspace: surface.setAiChatWorkspace,
    onForkMessage: conversation.forkAtMessage,
    onEditMessage: conversation.editMessage,
    onRetryMessage: homeActions.retryMessage,
    onSelectHistory: homeActions.selectHistory,
    onDeleteHistory: conversation.deleteHistory,
    onSelectProject: conversation.selectProject,
    onCreateProject: conversation.createProject,
    onNewTask: conversation.startTask,
    onPinProject: conversation.toggleProjectPin,
    onPinHistory: conversation.toggleHistoryPin,
    onMoveHistory: conversation.moveHistoryToProject,
    onRenameProject: conversation.renameProject,
    onUpdateWorkspace: conversation.updateWorkspace,
    onClose: surface.closeAiChat,
    onRun: options.run,
    onStop: options.stop,
    onClear: options.clear,
    onInsert: homeActions.insertMessage,
    onCopyMessage: homeActions.copyMessage,
    onWriteMessageToChild: options.writeMessageToChildDocument,
    onOpenSource: homeActions.openSourceDocument,
    onResearchCandidateAction: researchActions.handleResearchCandidateAction,
    onResolveReviewIssue: researchActions.resolveReviewIssue,
    onSelectTarget: options.selectTarget,
    onClearTarget: options.clearTarget,
  }))
}
