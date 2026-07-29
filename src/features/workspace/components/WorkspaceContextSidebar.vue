<script setup lang="ts">
import {
  Bot,
  CalendarClock,
  ChevronRight,
  FileClock,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Plus,
  Pin,
  Search,
  Trash2,
} from '@lucide/vue'
import { computed, ref } from 'vue'

import type { InboxSection, WorkspaceSurface } from '@/models/workspace/workspaceSurface'
import type { AgentProject, AiChatHistoryItem } from '@/models/ai/aiChatHistory'
import { UNGROUPED_AGENT_PROJECT_ID } from '@/models/ai/aiChatHistory'
import {
  WORKSPACE_SECTIONS,
  type WorkspaceSectionSurface,
} from '@/features/workspace/workspaceSections'

const props = defineProps<{
  activeSurface: WorkspaceSurface
  inboxSection: InboxSection
  knowledgeSection: string
  pluginSection: string
  automationSection: string
  auditCategory: string
  settingsSection: string
  projects: AgentProject[]
  histories: AiChatHistoryItem[]
  currentProjectId: string
  currentHistoryId: string | null
}>()

const emit = defineEmits<{
  'update:knowledge-section': [value: string]
  'update:inbox-section': [value: InboxSection]
  'update:plugin-section': [value: string]
  'update:automation-section': [value: string]
  'update:audit-category': [value: string]
  'update:settings-section': [value: string]
  'select-project': [value: string]
  'select-history': [value: string]
  'delete-history': [value: string]
  'new-task': [projectId: string | null]
  'new-project': []
  'open-agent': []
  'open-automations': []
  'pin-project': [projectId: string]
  'delete-project': [projectId: string]
  search: []
}>()

const titles: Partial<Record<WorkspaceSurface, string>> = {
  agent: '任务列表',
  inbox: '收件箱',
  knowledge: '知识控制',
  plugins: '连接与扩展',
  automations: '自动化任务',
  audit: '活动与审计',
  settings: '设置选项',
}

const sections = computed(() => {
  if (props.activeSurface in WORKSPACE_SECTIONS) {
    return WORKSPACE_SECTIONS[props.activeSurface as WorkspaceSectionSurface]
  }
  return []
})

const selectedSection = computed(
  () =>
    ({
      inbox: props.inboxSection,
      knowledge: props.knowledgeSection,
      plugins: props.pluginSection,
      automations: props.automationSection,
      audit: props.auditCategory,
      settings: props.settingsSection,
    })[props.activeSurface] ?? '',
)

function selectSection(id: string): void {
  if (props.activeSurface === 'inbox') emit('update:inbox-section', id as InboxSection)
  if (props.activeSurface === 'knowledge') emit('update:knowledge-section', id)
  if (props.activeSurface === 'plugins') emit('update:plugin-section', id)
  if (props.activeSurface === 'automations') emit('update:automation-section', id)
  if (props.activeSurface === 'audit') emit('update:audit-category', id)
  if (props.activeSurface === 'settings') emit('update:settings-section', id)
}

function historiesForProject(projectId: string): AiChatHistoryItem[] {
  return props.histories.filter((history) => history.projectId === projectId)
}

const ungroupedHistories = computed(() => historiesForProject(UNGROUPED_AGENT_PROJECT_ID))
const collapsedProjectIds = ref<Set<string>>(readCollapsedProjectIds())

function toggleProject(projectId: string): void {
  const next = new Set(collapsedProjectIds.value)
  if (next.has(projectId)) next.delete(projectId)
  else next.add(projectId)
  collapsedProjectIds.value = next
  persistCollapsedProjectIds(next)
}

function selectProject(projectId: string): void {
  if (collapsedProjectIds.value.has(projectId)) {
    const next = new Set(collapsedProjectIds.value)
    next.delete(projectId)
    collapsedProjectIds.value = next
    persistCollapsedProjectIds(next)
  }
  emit('select-project', projectId)
}

function startTaskFromCurrentSelection(): void {
  emit(
    'new-task',
    props.currentProjectId && props.currentProjectId !== UNGROUPED_AGENT_PROJECT_ID
      ? props.currentProjectId
      : null,
  )
}

function readCollapsedProjectIds(): Set<string> {
  try {
    const value = JSON.parse(
      globalThis.localStorage?.getItem('my-notebook:agent-project-folders') ?? '[]',
    )
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

function persistCollapsedProjectIds(ids: Set<string>): void {
  try {
    globalThis.localStorage?.setItem('my-notebook:agent-project-folders', JSON.stringify([...ids]))
  } catch {
    // Folder state remains available for the current session.
  }
}

function deleteProject(project: AgentProject): void {
  if (!globalThis.confirm(`删除项目“${project.name}”？其中的对话也会一并删除。`)) return
  emit('delete-project', project.id)
}
</script>

<template>
  <aside class="document-sidebar context-sidebar" :aria-label="titles[activeSurface]">
    <header class="sidebar-brand context-sidebar__search">
      <button type="button" class="sidebar-search-trigger" @click="emit('search')">
        <Search :size="15" />
        <span>搜索工作区</span>
        <kbd>Ctrl K</kbd>
      </button>
    </header>
    <nav
      v-if="activeSurface === 'agent' || activeSurface === 'automations'"
      class="context-sidebar__domain-switch"
      aria-label="工作分类"
    >
      <button
        type="button"
        :class="{ 'is-active': activeSurface === 'agent' }"
        @click="emit('open-agent')"
      >
        <Bot :size="14" />Agent 任务
      </button>
      <button
        type="button"
        :class="{ 'is-active': activeSurface === 'automations' }"
        @click="emit('open-automations')"
      >
        <CalendarClock :size="14" />自动化
      </button>
    </nav>
    <div v-if="activeSurface === 'agent'" class="context-sidebar__actions">
      <button type="button" @click="emit('new-project')">
        <Plus :size="15" /><span>新建项目</span>
      </button>
      <button type="button" @click="startTaskFromCurrentSelection">
        <FileText :size="15" /><span>新建任务</span>
      </button>
    </div>
    <header v-else class="context-sidebar__header">
      <span>{{ titles[activeSurface] }}</span>
    </header>

    <div v-if="activeSurface === 'agent'" class="context-sidebar__body">
      <div v-for="project in projects" :key="project.id" class="context-sidebar__project">
        <div
          class="context-sidebar__folder-row"
          :class="{ 'is-active': currentProjectId === project.id }"
        >
          <button
            type="button"
            class="context-sidebar__folder-toggle"
            :aria-label="`${collapsedProjectIds.has(project.id) ? '展开' : '折叠'}项目：${project.name}`"
            @click="toggleProject(project.id)"
          >
            <ChevronRight
              :size="13"
              :class="{ 'is-expanded': !collapsedProjectIds.has(project.id) }"
            />
          </button>
          <button type="button" class="context-sidebar__folder" @click="selectProject(project.id)">
            <Folder v-if="collapsedProjectIds.has(project.id)" :size="16" />
            <FolderOpen v-else :size="16" />
            <span>{{ project.name }}</span>
          </button>
          <button
            type="button"
            class="context-sidebar__project-new"
            :aria-label="`在项目中新建任务：${project.name}`"
            title="新建任务"
            @click.stop="emit('new-task', project.id)"
          >
            <FilePlus2 :size="13" />
          </button>
          <button
            type="button"
            class="context-sidebar__project-pin"
            :class="{ 'is-pinned': project.pinnedAt !== null }"
            :aria-label="`${project.pinnedAt !== null ? '取消置顶' : '置顶'}项目：${project.name}`"
            @click="emit('pin-project', project.id)"
          >
            <Pin :size="13" />
          </button>
          <button
            type="button"
            class="context-sidebar__project-delete"
            :aria-label="`删除项目：${project.name}`"
            @click.stop="deleteProject(project)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
        <template v-if="!collapsedProjectIds.has(project.id)">
          <div
            v-for="history in historiesForProject(project.id)"
            :key="history.id"
            class="context-sidebar__history-row"
            :class="{ 'is-draft': history.transient }"
          >
            <button
              type="button"
              class="context-sidebar__item context-sidebar__item--nested"
              :class="{ 'is-active': currentHistoryId === history.id }"
              :title="history.title"
              @click="emit('select-history', history.id)"
            >
              <FilePlus2 v-if="history.transient" :size="15" />
              <FileClock v-else :size="15" />
              <span
                ><strong>{{ history.title }}</strong
                ><small>{{
                  history.transient ? '草稿 · 尚未保存' : `${history.messageCount} 条消息`
                }}</small></span
              >
            </button>
            <button
              v-if="!history.transient"
              type="button"
              class="context-sidebar__history-delete"
              :aria-label="`删除对话：${history.title}`"
              @click="emit('delete-history', history.id)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
        </template>
      </div>
      <div
        v-if="ungroupedHistories.length || currentProjectId === UNGROUPED_AGENT_PROJECT_ID"
        class="context-sidebar__project"
      >
        <div
          class="context-sidebar__folder-row"
          :class="{ 'is-active': currentProjectId === UNGROUPED_AGENT_PROJECT_ID }"
        >
          <span></span>
          <button type="button" class="context-sidebar__folder" @click="emit('new-task', null)">
            <Folder :size="16" /><span>未分组</span>
          </button>
          <button
            type="button"
            class="context-sidebar__project-new"
            aria-label="新建未分组任务"
            title="新建任务"
            @click="emit('new-task', null)"
          >
            <FilePlus2 :size="13" />
          </button>
        </div>
        <div
          v-for="history in ungroupedHistories"
          :key="history.id"
          class="context-sidebar__history-row"
          :class="{ 'is-draft': history.transient }"
        >
          <button
            type="button"
            class="context-sidebar__item context-sidebar__item--nested"
            :class="{ 'is-active': currentHistoryId === history.id }"
            :title="history.title"
            @click="emit('select-history', history.id)"
          >
            <FilePlus2 v-if="history.transient" :size="15" />
            <FileClock v-else :size="15" />
            <span
              ><strong>{{ history.title }}</strong
              ><small>{{
                history.transient ? '草稿 · 尚未保存' : `${history.messageCount} 条消息`
              }}</small></span
            >
          </button>
          <button
            v-if="!history.transient"
            type="button"
            class="context-sidebar__history-delete"
            :aria-label="`删除对话：${history.title}`"
            @click="emit('delete-history', history.id)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
      </div>
      <p v-if="projects.length === 0 && histories.length === 0" class="context-sidebar__empty">
        暂无任务
      </p>
    </div>

    <nav v-else class="context-sidebar__body" :aria-label="titles[activeSurface]">
      <button
        v-for="section in sections"
        :key="section.id"
        type="button"
        class="context-sidebar__item"
        :class="{ 'is-active': selectedSection === section.id }"
        @click="selectSection(section.id)"
      >
        <component :is="section.icon" :size="16" />
        <span
          ><strong>{{ section.label }}</strong
          ><small>{{ section.description }}</small></span
        >
      </button>
    </nav>
  </aside>
</template>
