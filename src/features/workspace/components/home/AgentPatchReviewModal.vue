<script setup lang="ts">
import { Check, ChevronDown, FileDiff, ShieldCheck, X } from '@lucide/vue'

import { NButton } from '@/ui'
import type { AgentPatchSet, AgentTask, BlockPatch } from '@/models/agent'

type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserInput = InstanceType<typeof globalThis.HTMLInputElement>
type BrowserTextArea = InstanceType<typeof globalThis.HTMLTextAreaElement>

defineProps<{
  task: AgentTask | null
  patchSet: AgentPatchSet | null
  patches: BlockPatch[]
  acceptedCount: number
  workspace?: boolean
}>()

const show = defineModel<boolean>('show', { required: true })

const emit = defineEmits<{
  'update-accepted': [patchId: string, accepted: boolean]
  'update-after': [patchId: string, content: string]
  'select-none': []
  reject: []
  'accept-all': []
  apply: []
}>()

function updateAccepted(patchId: string, event: BrowserEvent): void {
  emit('update-accepted', patchId, (event.target as BrowserInput).checked)
}

function updateAfter(patchId: string, event: BrowserEvent): void {
  emit('update-after', patchId, (event.target as BrowserTextArea).value)
}
</script>

<template>
  <Transition name="agent-review-panel">
    <aside
      v-if="show && task && patchSet"
      class="agent-patch-panel"
      :class="{ 'agent-patch-panel--workspace': workspace }"
      aria-label="Agent 修改审阅"
    >
      <header class="agent-patch-panel__header">
        <div>
          <span class="agent-patch-panel__eyebrow"><FileDiff :size="13" /> 修改提案</span>
          <strong>审阅 Agent 修改</strong>
          <small
            >{{ patchSet.model }} · {{ patches.length }} 项，{{ acceptedCount }} 项已选择</small
          >
        </div>
        <button type="button" aria-label="收起修改审阅" title="稍后审阅" @click="show = false">
          <X :size="17" />
        </button>
      </header>

      <div class="agent-patch-panel__notice">
        <ShieldCheck :size="15" />
        <span><strong>修改尚未写入</strong>，你可以继续查看文档，确认时会再次校验版本。</span>
      </div>

      <section class="agent-patch-review">
        <header class="agent-patch-review__summary">
          <strong>{{ task.currentStep }}</strong>
          <small>展开单项可对比并编辑修改后的内容。</small>
        </header>

        <details
          v-for="(patch, index) in patches"
          :key="patch.patchId"
          class="agent-patch-card"
          :class="{ 'agent-patch-card--rejected': !patch.accepted }"
        >
          <summary>
            <label @click.stop>
              <input
                type="checkbox"
                :checked="patch.accepted"
                :aria-label="`选择修改 ${index + 1}`"
                @change="updateAccepted(patch.patchId, $event)"
              />
              <span class="agent-patch-card__check"><Check :size="12" /></span>
            </label>
            <span class="agent-patch-card__title">
              <strong>{{
                patch.operation === 'create_document'
                  ? `新建文档：${patch.documentTitle}`
                  : `${patch.operation === 'replace' ? '替换' : '插入'} ${patch.targetBlockIds.length} 个块`
              }}</strong>
              <small v-if="patch.operation !== 'create_document'"
                >Revision {{ patch.expectedVersion }}</small
              >
            </span>
            <ChevronDown :size="16" class="agent-patch-card__chevron" />
          </summary>
          <div class="agent-patch-card__body">
            <p class="agent-patch-card__reason">{{ patch.reason }}</p>
            <div class="agent-diff">
              <section>
                <strong>{{ patch.operation === 'create_document' ? '新文档' : '修改前' }}</strong>
                <pre>{{
                  patch.operation === 'create_document'
                    ? patch.documentTitle
                    : patch.before || '（空块）'
                }}</pre>
              </section>
              <section>
                <strong>修改后 · 可编辑</strong>
                <textarea
                  :value="patch.after"
                  rows="8"
                  aria-label="编辑 Agent 修改后内容"
                  @input="updateAfter(patch.patchId, $event)"
                ></textarea>
              </section>
            </div>
          </div>
        </details>
      </section>

      <footer class="agent-patch-panel__footer">
        <div>
          <strong>{{ acceptedCount }} / {{ patches.length }}</strong>
          <span>项修改将被写入</span>
        </div>
        <button v-if="acceptedCount" type="button" @click="emit('select-none')">清空选择</button>
        <button type="button" class="agent-patch-panel__reject" @click="emit('reject')">
          全部拒绝
        </button>
        <NButton type="primary" :disabled="acceptedCount === 0" @click="emit('apply')">
          应用选中修改
        </NButton>
      </footer>
    </aside>
  </Transition>

  <Transition name="agent-review-trigger">
    <button
      v-if="!show && task && patchSet"
      type="button"
      class="agent-review-trigger"
      :class="{ 'agent-review-trigger--workspace': workspace }"
      @click="show = true"
    >
      <span><FileDiff :size="16" /></span>
      <span>
        <strong>{{ patches.length }} 项修改待确认</strong>
        <small>{{ acceptedCount }} 项已选择 · 点击继续审阅</small>
      </span>
      <ChevronDown :size="15" class="agent-review-trigger__open" />
    </button>
  </Transition>
</template>
