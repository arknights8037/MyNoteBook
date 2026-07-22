<script setup lang="ts">
import { NButton, NInput, NModal } from '@/ui'
import type { DocumentSummary } from '@/models/documents/document'

defineProps<{
  renamingDocument: DocumentSummary | null
  busy: boolean
}>()

const showRename = defineModel<boolean>('showRename', { required: true })
const renameTitle = defineModel<string>('renameTitle', { required: true })
const showCreateGroup = defineModel<boolean>('showCreateGroup', { required: true })
const groupTitle = defineModel<string>('groupTitle', { required: true })

const emit = defineEmits<{
  commitRename: []
  cancelRename: []
  resetRename: []
  createGroup: []
}>()
</script>

<template>
  <NModal
    v-model:show="showRename"
    preset="card"
    :title="renamingDocument?.documentKind === 'group' ? '重命名分组' : '重命名页面'"
    class="rename-modal"
    :bordered="false"
    @after-leave="emit('resetRename')"
  >
    <NInput
      v-model:value="renameTitle"
      autofocus
      maxlength="80"
      show-count
      placeholder="输入新名称"
      aria-label="新名称"
      @keydown.enter.prevent="emit('commitRename')"
      @keydown.esc.prevent="emit('cancelRename')"
    />
    <template #footer>
      <div class="modal-actions">
        <NButton @click="emit('cancelRename')">取消</NButton>
        <NButton type="primary" :loading="busy" @click="emit('commitRename')">保存</NButton>
      </div>
    </template>
  </NModal>

  <NModal v-model:show="showCreateGroup" preset="card" title="新建分组" class="create-group-modal" :bordered="false">
    <NInput v-model:value="groupTitle" autofocus placeholder="输入分组名称" @keydown.enter.prevent="emit('createGroup')" />
    <template #footer>
      <div class="modal-actions">
        <NButton @click="showCreateGroup = false">取消</NButton>
        <NButton type="primary" :disabled="busy" @click="emit('createGroup')">创建</NButton>
      </div>
    </template>
  </NModal>
</template>
