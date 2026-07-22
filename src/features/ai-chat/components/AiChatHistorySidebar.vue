<script setup lang="ts">
import {
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  SlidersHorizontal,
  Trash2,
} from '@lucide/vue'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'
import { computed, ref } from 'vue'

import { UNGROUPED_AGENT_PROJECT_ID, type AgentProject } from '@/models/ai/aiChatHistory'
import type { AiChatPanelHistoryItem, AiChatWorkspaceOption } from './aiChatPanelTypes'

type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>

const props = defineProps<{
  collapsed: boolean
  chatHistory: AiChatPanelHistoryItem[]
  projects: AgentProject[]
  currentProjectId: string
  workspaceOptions: AiChatWorkspaceOption[]
  currentWorkspaceRootIds: string[]
  currentHistoryId: string | null
}>()

const emit = defineEmits<{
  'toggle-collapsed': []
  'create-project': []
  'select-history': [historyId: string]
  'delete-history': [historyId: string]
  'select-project': [projectId: string]
  'new-task': [projectId: string | null]
  'pin-project': [projectId: string]
  'pin-history': [historyId: string]
  'move-history': [historyId: string, projectId: string]
  'rename-project': [projectId: string, name: string]
  'update-workspace': [projectId: string, rootIds: string[]]
}>()

const showWorkspaceSettings = ref(false)
const collapsedProjectIds = ref<Set<string>>(new Set())
const ungroupedHistory = computed(() =>
  props.chatHistory.filter((item) => item.projectId === UNGROUPED_AGENT_PROJECT_ID),
)

function toggleProjectExpanded(projectId: string): void {
  const next = new Set(collapsedProjectIds.value)
  if (next.has(projectId)) next.delete(projectId)
  else next.add(projectId)
  collapsedProjectIds.value = next
}

function selectProject(projectId: string): void {
  collapsedProjectIds.value.delete(projectId)
  collapsedProjectIds.value = new Set(collapsedProjectIds.value)
  emit('select-project', projectId)
}

function startTask(projectId: string | null): void {
  if (projectId) {
    collapsedProjectIds.value.delete(projectId)
    collapsedProjectIds.value = new Set(collapsedProjectIds.value)
  }
  emit('new-task', projectId)
}

function openProjectSettings(projectId: string): void {
  if (props.currentProjectId !== projectId) emit('select-project', projectId)
  showWorkspaceSettings.value =
    props.currentProjectId === projectId ? !showWorkspaceSettings.value : true
}

function updateProjectName(event: BrowserEvent): void {
  const name = (event.target as BrowserInputElement).value.trim()
  if (props.currentProjectId && name) emit('rename-project', props.currentProjectId, name)
}

function toggleWorkspaceRoot(rootId: string, checked: boolean): void {
  if (!props.currentProjectId) return
  const next = checked
    ? [...new Set([...props.currentWorkspaceRootIds, rootId])]
    : props.currentWorkspaceRootIds.filter((id) => id !== rootId)
  emit('update-workspace', props.currentProjectId, next)
}

function projectHistory(projectId: string): AiChatPanelHistoryItem[] {
  return props.chatHistory.filter((item) => item.projectId === projectId)
}

function formatHistoryTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}
</script>

<template>
  <aside
    class="ai-chat-history"
    :class="{ 'ai-chat-history--collapsed': collapsed }"
    aria-label="Agent 对话历史"
  >
    <div class="ai-chat-history__header">
      <span v-if="!collapsed">项目</span>
      <button
        type="button"
        :aria-label="collapsed ? '展开对话历史' : '折叠对话历史'"
        @click="emit('toggle-collapsed')"
      >
        <PanelLeftOpen v-if="collapsed" :size="15" />
        <PanelLeftClose v-else :size="15" />
      </button>
    </div>
    <button
      type="button"
      class="ai-chat-history__create-project"
      aria-label="新建 Agent 项目"
      :title="collapsed ? '新建项目' : undefined"
      @click="emit('create-project')"
    >
      <FolderPlus :size="15" />
      <span v-if="!collapsed">新建项目</span>
    </button>
    <button
      type="button"
      class="ai-chat-history__new"
      aria-label="新建未分组任务"
      :title="collapsed ? '新建未分组任务' : undefined"
      @click="startTask(null)"
    >
      <FilePlus2 :size="15" />
      <span v-if="!collapsed">新建任务</span>
      <small v-if="!collapsed">未分组</small>
    </button>
    <div v-if="!collapsed" class="ai-chat-project-list" role="list">
      <section
        v-if="ungroupedHistory.length > 0 || currentProjectId === UNGROUPED_AGENT_PROJECT_ID"
        class="ai-chat-project ai-chat-project--ungrouped"
        :class="{ 'is-active': currentProjectId === UNGROUPED_AGENT_PROJECT_ID }"
        role="listitem"
      >
        <div class="ai-chat-project__row ai-chat-project__row--ungrouped">
          <span class="ai-chat-project__ungrouped-spacer" aria-hidden="true"></span>
          <button
            type="button"
            class="ai-chat-project__select"
            :aria-current="currentProjectId === UNGROUPED_AGENT_PROJECT_ID ? 'true' : undefined"
            @click="startTask(null)"
          >
            <FileText :size="15" />
            <span>未分组</span>
          </button>
          <button
            type="button"
            class="ai-chat-project__action"
            aria-label="新建未分组任务"
            @click="startTask(null)"
          >
            <FilePlus2 :size="13" />
          </button>
        </div>
        <div class="ai-chat-project__conversations" role="list">
          <article
            v-for="historyItem in ungroupedHistory"
            :key="historyItem.id"
            class="ai-chat-history__item ai-chat-history__item--movable"
            :class="{ 'is-active': currentHistoryId === historyItem.id }"
            role="listitem"
          >
            <button
              type="button"
              class="ai-chat-history__select"
              :aria-current="currentHistoryId === historyItem.id ? 'true' : undefined"
              @click="emit('select-history', historyItem.id)"
            >
              <strong>{{ historyItem.title }}</strong>
              <small>{{ formatHistoryTime(historyItem.updatedAt) }}</small>
            </button>
            <button
              type="button"
              class="ai-chat-history__pin"
              :class="{ 'is-pinned': historyItem.pinnedAt !== null }"
              :aria-label="`${historyItem.pinnedAt !== null ? '取消置顶' : '置顶'}对话：${historyItem.title}`"
              @click="emit('pin-history', historyItem.id)"
            >
              <Pin :size="12" />
            </button>
            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <button
                  type="button"
                  class="ai-chat-history__move"
                  :aria-label="`将任务加入项目：${historyItem.title}`"
                  title="加入项目并切换资料视野"
                >
                  <FolderInput :size="12" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent
                  class="ai-chat-menu ai-chat-history-move-menu"
                  align="start"
                  :side-offset="5"
                >
                  <div class="ai-chat-history-move-menu__header">
                    <strong>加入项目</strong>
                    <small>任务将使用该项目的资料视野</small>
                  </div>
                  <DropdownMenuItem
                    v-for="project in projects"
                    :key="project.id"
                    class="ai-chat-menu__item ai-chat-history-move-menu__item"
                    @select="emit('move-history', historyItem.id, project.id)"
                  >
                    <Folder :size="14" />
                    <span>
                      <strong>{{ project.name }}</strong>
                      <small>
                        {{
                          project.workspaceRootIds.length
                            ? `${project.workspaceRootIds.length} 个资料分组`
                            : '未限定资料分组'
                        }}
                      </small>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>
            <button
              type="button"
              class="ai-chat-history__delete"
              :aria-label="`删除聊天记录：${historyItem.title}`"
              @click="emit('delete-history', historyItem.id)"
            >
              <Trash2 :size="12" />
            </button>
          </article>
        </div>
      </section>
      <p v-if="projects.length === 0" class="ai-chat-history__empty">暂无项目</p>
      <section
        v-for="project in projects"
        :key="project.id"
        class="ai-chat-project"
        :class="{ 'is-active': currentProjectId === project.id }"
        role="listitem"
      >
        <div class="ai-chat-project__row">
          <button
            type="button"
            class="ai-chat-project__expand"
            :aria-label="`${collapsedProjectIds.has(project.id) ? '展开' : '折叠'}项目：${project.name}`"
            @click="toggleProjectExpanded(project.id)"
          >
            <ChevronRight
              :size="14"
              :class="{ 'is-expanded': !collapsedProjectIds.has(project.id) }"
            />
          </button>
          <button
            type="button"
            class="ai-chat-project__select"
            :aria-current="currentProjectId === project.id ? 'true' : undefined"
            @click="selectProject(project.id)"
          >
            <FolderOpen v-if="!collapsedProjectIds.has(project.id)" :size="16" />
            <Folder v-else :size="16" />
            <span>{{ project.name }}</span>
          </button>
          <button
            type="button"
            class="ai-chat-project__action"
            :aria-label="`在项目中新建任务：${project.name}`"
            @click="startTask(project.id)"
          >
            <FilePlus2 :size="13" />
          </button>
          <button
            type="button"
            class="ai-chat-project__action"
            :class="{ 'is-pinned': project.pinnedAt !== null }"
            :aria-label="`${project.pinnedAt !== null ? '取消置顶' : '置顶'}项目：${project.name}`"
            @click="emit('pin-project', project.id)"
          >
            <Pin :size="13" />
          </button>
          <button
            type="button"
            class="ai-chat-project__action"
            :aria-pressed="currentProjectId === project.id && showWorkspaceSettings"
            :aria-label="`配置项目：${project.name}`"
            @click="openProjectSettings(project.id)"
          >
            <SlidersHorizontal :size="13" />
          </button>
        </div>
        <section
          v-if="currentProjectId === project.id && showWorkspaceSettings"
          class="ai-chat-workspace-settings"
          aria-label="项目工作区设置"
        >
          <label>
            <span>项目名称</span>
            <input :value="project.name" maxlength="80" @change="updateProjectName" />
          </label>
          <fieldset>
            <legend>允许检索的文档分组</legend>
            <label v-for="option in workspaceOptions" :key="option.value">
              <input
                type="checkbox"
                :checked="currentWorkspaceRootIds.includes(option.value)"
                @change="
                  toggleWorkspaceRoot(option.value, ($event.target as HTMLInputElement).checked)
                "
              />
              <span>{{ option.label }}</span>
            </label>
          </fieldset>
          <p>默认只检索上述范围；证据不足时，Agent 可主动扩大到全库。</p>
        </section>
        <div
          v-if="!collapsedProjectIds.has(project.id)"
          class="ai-chat-project__conversations"
          role="list"
        >
          <button
            v-if="projectHistory(project.id).length === 0"
            type="button"
            class="ai-chat-project__empty-conversation"
            @click="startTask(project.id)"
          >
            <FilePlus2 :size="12" />新建任务
          </button>
          <article
            v-for="historyItem in projectHistory(project.id)"
            :key="historyItem.id"
            class="ai-chat-history__item"
            :class="{ 'is-active': currentHistoryId === historyItem.id }"
            role="listitem"
          >
            <button
              type="button"
              class="ai-chat-history__select"
              :aria-current="currentHistoryId === historyItem.id ? 'true' : undefined"
              @click="emit('select-history', historyItem.id)"
            >
              <strong>{{ historyItem.title }}</strong>
              <small>{{ formatHistoryTime(historyItem.updatedAt) }}</small>
            </button>
            <button
              type="button"
              class="ai-chat-history__pin"
              :class="{ 'is-pinned': historyItem.pinnedAt !== null }"
              :aria-label="`${historyItem.pinnedAt !== null ? '取消置顶' : '置顶'}对话：${historyItem.title}`"
              @click="emit('pin-history', historyItem.id)"
            >
              <Pin :size="12" />
            </button>
            <button
              type="button"
              class="ai-chat-history__delete"
              :aria-label="`删除聊天记录：${historyItem.title}`"
              @click="emit('delete-history', historyItem.id)"
            >
              <Trash2 :size="12" />
            </button>
          </article>
        </div>
      </section>
    </div>
  </aside>
</template>
