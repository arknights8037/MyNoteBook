<script setup lang="ts">
import { CirclePause, CornerDownRight, ShieldQuestion } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import { NButton, NModal } from '@/ui'
import type { AgentAuthorizationRequest } from '@/models/agent/agentRuntime'

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
      <header>
        <span><ShieldQuestion :size="18" aria-hidden="true" /></span>
        <div>
          <strong>执行已暂停在当前步骤</strong>
          <small>你的回答会成为下一轮的明确约束</small>
        </div>
      </header>
      <p>{{ request.question }}</p>
      <small v-if="request.context" class="ai-authorizer-card__context">{{
        request.context
      }}</small>
      <ol class="agent-authorization-modal__progress" aria-label="授权处理进度">
        <li class="agent-authorization-modal__progress--completed"><span>✓</span>现场已保留</li>
        <li class="agent-authorization-modal__progress--active"><span>2</span>等待你的决定</li>
        <li><span>3</span>从当前步骤继续</li>
      </ol>
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
      <p class="agent-authorization-modal__resume-note">
        <CirclePause :size="14" aria-hidden="true" />
        Agent 不会在后台绕过此问题；选择后会原地恢复，无需重新提交任务。
        <CornerDownRight :size="13" aria-hidden="true" />
      </p>
    </section>
    <template #footer>
      <div class="modal-actions agent-authorization-modal__footer">
        <small>取消任务会保留当前对话和已完成的工具记录。</small>
        <NButton class="agent-authorization-modal__cancel" @click="emit('cancel')"
          >取消任务</NButton
        >
      </div>
    </template>
  </NModal>
</template>
