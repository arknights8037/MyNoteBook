<script setup lang="ts">
import { ChevronLeft, ChevronRight, Plus, Trash2 } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'

import type { InformationHomeCalendarEvent } from '@/models/home/informationHome'

interface CalendarDay {
  date: Date
  key: string
  day: number
  currentMonth: boolean
  today: boolean
}

const props = withDefaults(
  defineProps<{
    events: InformationHomeCalendarEvent[]
    editing: boolean
    persistenceState?: 'idle' | 'saving' | 'saved' | 'error'
  }>(),
  { persistenceState: 'idle' },
)
const emit = defineEmits<{
  update: [events: InformationHomeCalendarEvent[]]
  metrics: [items: Array<{ value: number; label: string }>]
}>()
const cursor = ref(startOfMonth(new Date()))
const eventTitle = ref('')
const eventDate = ref(formatDateKey(new Date()))
const monthLabel = computed(() =>
  new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(cursor.value),
)
const days = computed<CalendarDay[]>(() => {
  const first = startOfMonth(cursor.value)
  const gridStart = new Date(first)
  gridStart.setDate(first.getDate() - first.getDay())
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart)
    date.setDate(gridStart.getDate() + index)
    return {
      date,
      key: formatDateKey(date),
      day: date.getDate(),
      currentMonth: date.getMonth() === cursor.value.getMonth(),
      today: formatDateKey(date) === formatDateKey(new Date()),
    }
  })
})

function publishMetrics(): void {
  const monthPrefix = formatDateKey(cursor.value).slice(0, 7)
  const today = formatDateKey(new Date())
  emit('metrics', [
    {
      value: props.events.filter((event) => event.date.startsWith(monthPrefix)).length,
      label: '本月',
    },
    { value: props.events.filter((event) => event.date === today).length, label: '今日' },
  ])
}

function moveMonth(offset: number): void {
  cursor.value = new Date(cursor.value.getFullYear(), cursor.value.getMonth() + offset, 1)
  publishMetrics()
}

function addEvent(): void {
  const value = eventTitle.value.trim()
  if (!value || !eventDate.value || props.editing || props.persistenceState === 'saving') return
  emit('update', [
    ...props.events,
    {
      id: `calendar-${globalThis.crypto.randomUUID()}`,
      title: value.slice(0, 160),
      date: eventDate.value,
    },
  ])
  eventTitle.value = ''
}

function removeEvent(id: string): void {
  if (props.editing || props.persistenceState === 'saving') return
  emit(
    'update',
    props.events.filter((event) => event.id !== id),
  )
}

function eventsFor(date: string): InformationHomeCalendarEvent[] {
  return props.events.filter((event) => event.date === date).slice(0, 2)
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

onMounted(publishMetrics)
watch(() => props.events, publishMetrics, { deep: true })
</script>

<template>
  <div class="dashboard-widget-content home-calendar-widget">
    <div class="home-calendar-widget__toolbar">
      <button type="button" aria-label="上个月" @click="moveMonth(-1)">
        <ChevronLeft :size="15" />
      </button>
      <strong>{{ monthLabel }}</strong>
      <button type="button" aria-label="下个月" @click="moveMonth(1)">
        <ChevronRight :size="15" />
      </button>
    </div>
    <div class="home-calendar-widget__weekdays" aria-hidden="true">
      <span v-for="label in ['日', '一', '二', '三', '四', '五', '六']" :key="label">{{
        label
      }}</span>
    </div>
    <div class="home-calendar-widget__grid">
      <div
        v-for="day in days"
        :key="day.key"
        :class="{ 'is-outside': !day.currentMonth, 'is-today': day.today }"
      >
        <time :datetime="day.key">{{ day.day }}</time>
        <span v-for="event in eventsFor(day.key)" :key="event.id" :title="event.title">
          {{ event.title }}
          <button
            type="button"
            :disabled="editing || persistenceState === 'saving'"
            :aria-label="`删除日程：${event.title}`"
            @click="removeEvent(event.id)"
          >
            <Trash2 :size="10" />
          </button>
        </span>
      </div>
    </div>
    <form class="home-calendar-widget__composer" @submit.prevent="addEvent">
      <input
        v-model="eventDate"
        type="date"
        :disabled="editing || persistenceState === 'saving'"
        aria-label="日程日期"
      />
      <input
        v-model="eventTitle"
        type="text"
        maxlength="160"
        :disabled="editing || persistenceState === 'saving'"
        placeholder="添加日程…"
        aria-label="日程内容"
      />
      <button
        type="submit"
        :disabled="editing || persistenceState === 'saving' || !eventTitle.trim()"
        aria-label="添加日程"
      >
        <Plus :size="15" />
      </button>
    </form>
    <p
      v-if="persistenceState !== 'idle'"
      class="home-system-feedback"
      :class="`is-${persistenceState}`"
      role="status"
      aria-live="polite"
    >
      {{
        persistenceState === 'saving'
          ? '正在写入本地日程…'
          : persistenceState === 'saved'
            ? '已写入本地日程'
            : '日程写入失败，已恢复原数据'
      }}
    </p>
  </div>
</template>
