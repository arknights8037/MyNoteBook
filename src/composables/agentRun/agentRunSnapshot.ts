import { createAgentTask, findRelevantBlocksForInstruction, type AgentTask, type SelectedBlock } from '@/models/agent'
import type { AiChatMode } from '@/models/aiChatMode'
import type { AiSettings } from '@/models/ai'
import type { AgentRunDocumentSnapshot, AgentRunSnapshot } from './types'

export interface AgentEditPlan {
  task: AgentTask
  targetBlocks: SelectedBlock[]
  expectedRevision: number
  usesSelection: boolean
  foundTargetScope: boolean
}
export function captureAgentRunSnapshot(input: {
  prompt: string
  requestedMode: AiChatMode
  settings: AiSettings
  document: AgentRunDocumentSnapshot
}): AgentRunSnapshot {
  return {
    prompt: input.prompt.trim(),
    requestedMode: input.requestedMode,
    settings: cloneSettings(input.settings),
    document: cloneDocumentSnapshot(input.document),
  }
}

export function createAgentEditPlan(input: {
  snapshot: AgentRunSnapshot
  mode: 'edit' | 'agent'
  createId: () => string
}): AgentEditPlan | null {
  const { snapshot, mode } = input
  const document = snapshot.document
  let targetBlocks = document.hasBlockSelection ? document.selectedBlocks : []
  const usesSelection = mode === 'agent' && document.hasBlockSelection && targetBlocks.length > 0
  let foundTargetScope = false
  if (targetBlocks.length === 0) {
    const inferredBlocks = findRelevantBlocksForInstruction(snapshot.prompt, document.blocks)
    foundTargetScope = inferredBlocks.length > 0
    targetBlocks =
      inferredBlocks.length > 0
        ? inferredBlocks
        : mode === 'agent'
          ? document.blocks
          : document.blocks.slice(0, 1)
  }
  if (targetBlocks.length === 0 || document.revision === null) return null

  const task = createAgentTask({
    id: input.createId(),
    sessionId: document.id,
    userInstruction: snapshot.prompt,
    contextScope:
      mode === 'agent' && !usesSelection
        ? 'current_document'
        : targetBlocks.length > 1
          ? 'selection'
          : 'current_block',
    model: snapshot.settings.model,
  })
  task.status = 'running'
  task.currentStep = '正在生成修改补丁'
  return {
    task,
    targetBlocks,
    expectedRevision: document.revision,
    usesSelection,
    foundTargetScope,
  }
}

function cloneSettings(settings: AiSettings): AiSettings {
  return {
    ...settings,
    availableModels: [...settings.availableModels],
    providerProfiles: Object.fromEntries(
      Object.entries(settings.providerProfiles).map(([provider, profile]) => [
        provider,
        { ...profile, availableModels: [...profile.availableModels] },
      ]),
    ) as AiSettings['providerProfiles'],
  }
}

function cloneDocumentSnapshot(snapshot: AgentRunDocumentSnapshot): AgentRunDocumentSnapshot {
  return {
    ...snapshot,
    tags: [...snapshot.tags],
    blocks: snapshot.blocks.map((block) => ({ ...block })),
    selectedBlocks: snapshot.selectedBlocks.map((block) => ({ ...block })),
    documents: snapshot.documents.map((document) => ({ ...document, tags: [...document.tags] })),
  }
}
