<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { NButton, NModal } from '@/ui'
import type { AgentAuthorizationRequest } from '@/models/agentRuntime'

const props = defineProps<{
  request: AgentAuthorizationRequest
}>()

const emit = defineEmits<{
  answer: [requestId: string, answer: string]
  cancel: []
}>()

const customAnswer = ref('')
const visible = computed({
  get: () => true,
  set: (value: boolean) => {
    if (!value) emit('cancel')
  },
})

watch(
  () => props.request.id,
  () => {
    customAnswer.value = ''
  },
  { immediate: true },
)

function answer(value: string): void {
  const normalized = value.trim()
  if (normalized) emit('answer', props.request.id, normalized)
}
</script>

<template>
  <NModal v-model:show="visible" title="Agent 需要你的决策" class="agent-authorization-modal">
    <section class="ai-authorizer-card ai-authorizer-card--modal" aria-label="等待授权人回答">
      <p>{{ request.question }}</p>
      <small v-if="request.context" class="ai-authorizer-card__context">{{ request.context }}</small>
      <div v-if="request.options.length" class="ai-authorizer-options">
        <NButton
          v-for="option in request.options"
          :key="option"
          class="agent-authorization-modal__option"
          @click="answer(option)"
        >
          {{ option }}
        </NButton>
      </div>
      <div v-if="request.allowFreeText" class="ai-authorizer-card__answer">
        <textarea
          v-model="customAnswer"
          rows="2"
          placeholder="也可以输入自己的回答"
          aria-label="授权人回答"
          @keydown.ctrl.enter.prevent="answer(customAnswer)"
        ></textarea>
        <NButton type="primary" :disabled="!customAnswer.trim()" @click="answer(customAnswer)">
          继续执行
        </NButton>
      </div>
    </section>
    <template #footer>
      <div class="modal-actions">
        <NButton class="agent-authorization-modal__cancel" @click="emit('cancel')">取消任务</NButton>
      </div>
    </template>
  </NModal>
</template>
