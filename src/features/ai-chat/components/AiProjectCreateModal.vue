<script setup lang="ts">
import { Check, Folder, FolderPlus } from '@lucide/vue'
import { nextTick, ref, watch } from 'vue'

import { NButton, NIcon, NModal } from '@/ui'

type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>

const props = defineProps<{
  workspaceOptions: Array<{ label: string; value: string }>
  projectCount: number
}>()

const show = defineModel<boolean>('show', { required: true })

const emit = defineEmits<{
  create: [input: { name: string; workspaceRootIds: string[] }]
}>()

const nameElement = ref<BrowserInputElement | null>(null)
const projectName = ref('')
const workspaceRootIds = ref<string[]>([])

function resetForm(): void {
  projectName.value = ''
  workspaceRootIds.value = []
}

function close(): void {
  show.value = false
}

function submit(): void {
  const selectedWorkspaceName =
    workspaceRootIds.value.length === 1
      ? props.workspaceOptions.find((option) => option.value === workspaceRootIds.value[0])?.label
      : ''
  const name =
    projectName.value.trim() || selectedWorkspaceName || `新项目 ${props.projectCount + 1}`

  emit('create', { name, workspaceRootIds: [...workspaceRootIds.value] })
  close()
}

function toggleWorkspaceRoot(rootId: string, event: BrowserEvent): void {
  const checked = (event.target as BrowserInputElement).checked
  workspaceRootIds.value = checked
    ? [...new Set([...workspaceRootIds.value, rootId])]
    : workspaceRootIds.value.filter((id) => id !== rootId)

  if (checked && !projectName.value.trim()) {
    projectName.value =
      props.workspaceOptions.find((option) => option.value === rootId)?.label ?? ''
  }
}

watch(show, (isOpen) => {
  resetForm()
  if (isOpen) void nextTick(() => nameElement.value?.focus())
})
</script>

<template>
  <NModal v-model:show="show" title="新建项目" class="ai-chat-project-dialog">
    <form class="ai-chat-project-dialog__form" @submit.prevent="submit">
      <p class="ai-chat-project-dialog__intro">项目会集中管理一组对话和默认文档工作区。</p>
      <label class="ai-chat-project-dialog__name">
        <span>项目名称</span>
        <input
          ref="nameElement"
          v-model="projectName"
          maxlength="80"
          placeholder="例如：StudioSite"
        />
        <small>不填写时会使用所选工作区名称或自动生成名称。</small>
      </label>
      <fieldset>
        <legend>默认工作区 <small>可多选，也可以稍后配置</small></legend>
        <p v-if="workspaceOptions.length === 0" class="ai-chat-project-dialog__empty">
          暂无文档分组，将创建一个空项目。
        </p>
        <label
          v-for="option in workspaceOptions"
          :key="option.value"
          class="ai-chat-project-dialog__workspace"
        >
          <input
            type="checkbox"
            :checked="workspaceRootIds.includes(option.value)"
            @change="toggleWorkspaceRoot(option.value, $event)"
          />
          <Folder :size="16" />
          <span>{{ option.label }}</span>
          <Check v-if="workspaceRootIds.includes(option.value)" :size="14" aria-hidden="true" />
        </label>
      </fieldset>
      <p class="ai-chat-project-dialog__scope-note">
        Agent 默认在这些分组内检索；现有证据不足时仍可明确扩展到全库。
      </p>
      <footer>
        <NButton @click="close">取消</NButton>
        <NButton native-type="submit" type="primary">
          <template #icon
            ><NIcon :size="14"><FolderPlus /></NIcon
          ></template>
          创建项目
        </NButton>
      </footer>
    </form>
  </NModal>
</template>
