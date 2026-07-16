<script setup lang="ts">
import { Plus, Trash2 } from '@lucide/vue'
import type { SlidePage, SlidesViewPayload, SlideTemplateId } from '@/models/workspaceView'
const props = defineProps<{ payload: SlidesViewPayload }>()
const emit = defineEmits<{ update: [payload: SlidesViewPayload] }>()
const templates: Array<{ id: SlideTemplateId; label: string; slots: string[] }> = [
  { id: 'cover', label: '封面', slots: ['title', 'subtitle'] }, { id: 'section', label: '章节', slots: ['title', 'subtitle'] },
  { id: 'title-content', label: '标题正文', slots: ['title', 'body'] }, { id: 'two-column', label: '双栏', slots: ['title', 'left', 'right'] },
  { id: 'big-number', label: '大数字', slots: ['title', 'number', 'caption'] }, { id: 'quote', label: '引用', slots: ['quote', 'source'] },
  { id: 'summary', label: '总结', slots: ['title', 'body'] },
]
const slotsFor = (id: SlideTemplateId) => templates.find((item) => item.id === id)?.slots ?? []
function updatePage(id: string, patch: Partial<SlidePage>) { emit('update', { ...props.payload, pages: props.payload.pages.map((page) => page.id === id ? { ...page, ...patch } : page) }) }
function updateSlot(page: SlidePage, slot: string, value: string) { updatePage(page.id, { slots: { ...page.slots, [slot]: slot === 'body' ? value.split('\n').filter(Boolean) : value } }) }
function addPage() { emit('update', { ...props.payload, pages: [...props.payload.pages, { id: `slide-${globalThis.crypto.randomUUID()}`, templateId: 'title-content', slots: { title: '新页面', body: ['填写内容'] }, background: 'plain' }] }) }
function removePage(id: string) { if (props.payload.pages.length > 1) emit('update', { ...props.payload, pages: props.payload.pages.filter((page) => page.id !== id) }) }
function text(value: string | string[] | undefined) { return Array.isArray(value) ? value.join('\n') : value ?? '' }
</script>
<template><div class="slides-view-editor"><aside><button v-for="(page,index) in payload.pages" :key="page.id"><strong>{{ index + 1 }}</strong>{{ text(page.slots.title || page.slots.quote) }}</button><button @click="addPage"><Plus :size="14" />新增页面</button></aside><main><article v-for="page in payload.pages" :key="page.id" class="slide-editor-card"><header><select :value="page.templateId" @change="updatePage(page.id,{ templateId: ($event.target as HTMLSelectElement).value as SlideTemplateId })"><option v-for="item in templates" :key="item.id" :value="item.id">{{ item.label }}</option></select><select :value="page.background" @change="updatePage(page.id,{ background: ($event.target as HTMLSelectElement).value as SlidePage['background'] })"><option value="plain">纯色</option><option value="dark">深色</option><option value="gradient">渐变</option></select><button :disabled="payload.pages.length<=1" @click="removePage(page.id)"><Trash2 :size="14" /></button></header><section class="slide-preview" :class="`slide-preview--${page.background}`"><template v-for="slot in slotsFor(page.templateId)" :key="slot"><textarea :value="text(page.slots[slot])" :aria-label="slot" @input="updateSlot(page,slot,($event.target as HTMLTextAreaElement).value)" /></template></section></article></main></div></template>
