<script setup lang="ts">
import { Check, Plus, Trash2 } from '@lucide/vue'
import { onMounted, ref, watch } from 'vue'

import type { InformationHomeTodoItem } from '@/models/home/informationHome'

const props = defineProps<{ items: InformationHomeTodoItem[]; editing: boolean }>()
const emit = defineEmits<{
  update: [items: InformationHomeTodoItem[]]
  metrics: [items: Array<{ value: number; label: string }>]
}>()
const title = ref('')

function publishMetrics(): void {
  emit('metrics', [
    { value: props.items.filter((item) => !item.completed).length, label: '待完成' },
    { value: props.items.filter((item) => item.completed).length, label: '已完成' },
  ])
}

function addItem(): void {
  const value = title.value.trim()
  if (!value || props.editing) return
  emit('update', [
    ...props.items,
    {
      id: `todo-${globalThis.crypto.randomUUID()}`,
      title: value.slice(0, 160),
      completed: false,
      createdAt: Date.now(),
    },
  ])
  title.value = ''
}

function toggleItem(item: InformationHomeTodoItem): void {
  if (props.editing) return
  emit(
    'update',
    props.items.map((candidate) =>
      candidate.id === item.id ? { ...candidate, completed: !candidate.completed } : candidate,
    ),
  )
}

function removeItem(id: string): void {
  if (props.editing) return
  emit(
    'update',
    props.items.filter((item) => item.id !== id),
  )
}

onMounted(publishMetrics)
watch(() => props.items, publishMetrics, { deep: true })
</script>

<template>
  <div class="dashboard-widget-content home-list-widget">
    <form class="home-list-widget__composer" @submit.prevent="addItem">
      <input
        v-model="title"
        type="text"
        maxlength="160"
        :disabled="editing"
        placeholder="添加待办事项…"
        aria-label="待办内容"
      />
      <button type="submit" :disabled="editing || !title.trim()" aria-label="添加待办">
        <Plus :size="15" />
      </button>
    </form>
    <p v-if="!items.length" class="dashboard-widget-state">还没有待办事项。</p>
    <ul v-else class="home-list-widget__items">
      <li v-for="item in items" :key="item.id" :class="{ 'is-completed': item.completed }">
        <button
          type="button"
          class="home-list-widget__check"
          :disabled="editing"
          :aria-label="item.completed ? '恢复待办' : '完成待办'"
          @click="toggleItem(item)"
        >
          <Check v-if="item.completed" :size="13" />
        </button>
        <span>{{ item.title }}</span>
        <button
          type="button"
          class="home-list-widget__remove"
          :disabled="editing"
          aria-label="删除待办"
          @click="removeItem(item.id)"
        >
          <Trash2 :size="13" />
        </button>
      </li>
    </ul>
  </div>
</template>
