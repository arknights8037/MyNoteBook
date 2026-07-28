import type { Ref } from 'vue'

import type { AgentProject, AiChatHistoryItem } from '@/models/ai/aiChatHistory'
import { UNGROUPED_AGENT_PROJECT_ID } from '@/models/ai/aiChatHistory'
import type { AiHistoryPersistence } from './useAiHistoryPersistence'

export interface AiHistoryProjectsState {
  history: Ref<AiChatHistoryItem[]>
  projects: Ref<AgentProject[]>
  activeProjectId: Ref<string>
  currentId: Ref<string | null>
  createId: () => string
}

export interface AiHistoryProjects {
  startTask: (projectId: string | null) => boolean
  selectProject: (projectId: string) => AgentProject | null
  createProject: (input?: { name?: string; workspaceRootIds?: string[] }) => AgentProject
  removeProject: (projectId: string) => boolean
  toggleProjectPin: (projectId: string) => boolean
  renameProject: (projectId: string, name: string) => boolean
  updateWorkspace: (projectId: string, workspaceRootIds: string[]) => boolean
  ensureDefaultWorkspace: (rootId: string, name?: string) => void
}

export function createAiHistoryProjects(
  state: AiHistoryProjectsState,
  persistence: AiHistoryPersistence,
): AiHistoryProjects {
  function startTask(projectId: string | null): boolean {
    if (projectId === null) {
      state.activeProjectId.value = UNGROUPED_AGENT_PROJECT_ID
      state.currentId.value = null
      return true
    }
    const project = state.projects.value.find((candidate) => candidate.id === projectId) ?? null
    if (!project) return false
    state.activeProjectId.value = project.id
    state.currentId.value = null
    return true
  }

  function selectProject(projectId: string): AgentProject | null {
    const project = state.projects.value.find((candidate) => candidate.id === projectId) ?? null
    if (!project) return null
    state.activeProjectId.value = project.id
    state.currentId.value = null
    persistence.persist()
    return project
  }

  function createProject(input?: { name?: string; workspaceRootIds?: string[] }): AgentProject {
    const now = Date.now()
    const project: AgentProject = {
      id: state.createId(),
      name: input?.name?.trim().slice(0, 80) || `新项目 ${state.projects.value.length + 1}`,
      workspaceRootIds: [...new Set(input?.workspaceRootIds?.filter(Boolean) ?? [])],
      pinnedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    state.projects.value = [...state.projects.value, project]
    state.activeProjectId.value = project.id
    state.currentId.value = null
    persistence.persist()
    return project
  }

  function removeProject(projectId: string): boolean {
    const index = state.projects.value.findIndex((project) => project.id === projectId)
    if (index < 0) return false

    state.projects.value = state.projects.value.filter((project) => project.id !== projectId)
    state.history.value = state.history.value.filter((item) => item.projectId !== projectId)

    if (state.activeProjectId.value === projectId) {
      state.activeProjectId.value = state.projects.value[0]?.id ?? UNGROUPED_AGENT_PROJECT_ID
      state.currentId.value = null
    }
    persistence.persist()
    return true
  }

  function toggleProjectPin(projectId: string): boolean {
    return updateProject(projectId, (project) => ({
      ...project,
      pinnedAt: project.pinnedAt === null ? Date.now() : null,
    }))
  }

  function renameProject(projectId: string, name: string): boolean {
    const normalized = name.trim().slice(0, 80)
    if (!normalized) return false
    return updateProject(projectId, (project) => ({ ...project, name: normalized }))
  }

  function updateWorkspace(projectId: string, workspaceRootIds: string[]): boolean {
    const normalized = [...new Set(workspaceRootIds.filter(Boolean))]
    return updateProject(projectId, (project) => ({
      ...project,
      workspaceRootIds: normalized,
    }))
  }

  function ensureDefaultWorkspace(rootId: string, name = 'Agent MVP'): void {
    if (!persistence.isHydrated()) {
      persistence.setPendingDefaultWorkspace(rootId, name)
      return
    }
    const project = state.projects.value[0]
    if (!project || project.workspaceRootIds.length > 0 || !rootId) return
    state.projects.value = [
      { ...project, name, workspaceRootIds: [rootId], updatedAt: Date.now() },
      ...state.projects.value.slice(1),
    ]
    persistence.persist()
  }

  function updateProject(
    projectId: string,
    updater: (project: AgentProject) => AgentProject,
  ): boolean {
    const index = state.projects.value.findIndex((project) => project.id === projectId)
    const project = state.projects.value[index]
    if (!project) return false
    const updated = { ...updater(project), updatedAt: Date.now() }
    state.projects.value = state.projects.value.map((item, itemIndex) =>
      itemIndex === index ? updated : item,
    )
    persistence.persist()
    return true
  }

  return {
    startTask,
    selectProject,
    createProject,
    removeProject,
    toggleProjectPin,
    renameProject,
    updateWorkspace,
    ensureDefaultWorkspace,
  }
}
