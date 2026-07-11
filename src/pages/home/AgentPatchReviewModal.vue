<script setup lang="ts">
import { NButton, NModal } from '@/ui'
import type { AgentPatchSet, AgentTask, BlockPatch } from '@/models/agent'

type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserInput = InstanceType<typeof globalThis.HTMLInputElement>
type BrowserTextArea = InstanceType<typeof globalThis.HTMLTextAreaElement>

defineProps<{
  task: AgentTask | null
  patchSet: AgentPatchSet | null
  patches: BlockPatch[]
  acceptedCount: number
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
  <NModal
    v-model:show="show"
    preset="card"
    title="确认 Agent 修改"
    class="agent-patch-modal"
    :bordered="false"
  >
    <section v-if="task && patchSet" class="agent-patch-review">
      <header class="agent-patch-review__summary">
        <div>
          <strong>{{ task.currentStep }}</strong>
          <span>{{ patchSet.model }} · {{ patches.length }} 项修改</span>
        </div>
        <small>写入前会校验文档版本和目标块，冲突时不会修改文档。</small>
      </header>

      <article
        v-for="patch in patches"
        :key="patch.patchId"
        class="agent-patch-card"
        :class="{ 'agent-patch-card--rejected': !patch.accepted }"
      >
        <header>
          <label>
            <input
              type="checkbox"
              :checked="patch.accepted"
              @change="updateAccepted(patch.patchId, $event)"
            />
            <span>{{
              patch.operation === 'create_document'
                ? `新建文档：${patch.documentTitle}`
                : `${patch.operation === 'replace' ? '替换' : '插入'} ${patch.targetBlockIds.length} 个块`
            }}</span>
          </label>
          <small v-if="patch.operation !== 'create_document'">Revision {{ patch.expectedVersion }}</small>
        </header>
        <p class="agent-patch-card__reason">{{ patch.reason }}</p>
        <div class="agent-diff">
          <section>
            <strong>{{ patch.operation === 'create_document' ? '新文档' : '修改前' }}</strong>
            <pre>{{ patch.operation === 'create_document' ? patch.documentTitle : patch.before || '（空块）' }}</pre>
          </section>
          <section>
            <strong>修改后</strong>
            <textarea
              :value="patch.after"
              rows="8"
              aria-label="编辑 Agent 修改后内容"
              @input="updateAfter(patch.patchId, $event)"
            ></textarea>
          </section>
        </div>
      </article>
    </section>
    <template #footer>
      <div class="modal-actions">
        <NButton @click="emit('select-none')">取消全选</NButton>
        <NButton @click="emit('reject')">全部拒绝</NButton>
        <NButton secondary :disabled="patches.length === 0" @click="emit('accept-all')">
          全部接受
        </NButton>
        <NButton type="primary" :disabled="acceptedCount === 0" @click="emit('apply')">
          接受选中修改
        </NButton>
      </div>
    </template>
  </NModal>
</template>
