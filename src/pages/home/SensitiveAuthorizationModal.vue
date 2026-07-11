<script setup lang="ts">
import { NButton, NInput, NModal } from '@/ui'

defineProps<{
  title: string
  description: string
  error: string
}>()

const show = defineModel<boolean>('show', { required: true })
const password = defineModel<string>('password', { required: true })

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="title"
    class="sensitive-auth-modal"
    :bordered="false"
    @after-leave="password = ''"
  >
    <div class="sensitive-auth">
      <p>{{ description }}</p>
      <NInput
        v-model:value="password"
        autofocus
        type="password"
        placeholder="输入授权密码"
        autocomplete="current-password"
        aria-label="授权密码"
        @keydown.enter.prevent="emit('confirm')"
        @keydown.esc.prevent="emit('cancel')"
      />
      <small v-if="error">{{ error }}</small>
    </div>
    <template #footer>
      <div class="modal-actions">
        <NButton @click="emit('cancel')">取消</NButton>
        <NButton type="primary" @click="emit('confirm')">授权</NButton>
      </div>
    </template>
  </NModal>
</template>
