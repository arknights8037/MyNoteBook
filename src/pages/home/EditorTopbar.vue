<script setup lang="ts">
import { Archive, Ellipsis, ImagePlus, MessageSquare, Plus, Search, Share2 } from '@lucide/vue'

import NButton from '@/ui/NButton.vue'
import NIcon from '@/ui/NIcon.vue'
import NInput from '@/ui/NInput.vue'
import NTooltip from '@/ui/NTooltip.vue'

defineProps<{
  disabled: boolean
  busy: boolean
  hasDocument: boolean
  saveStatusClass: string
  saveStatusText: string
  preparingShare: boolean
}>()

const title = defineModel<string>('title', { required: true })

const emit = defineEmits<{
  titleInput: []
  commitTitle: []
  createChild: []
  share: []
  insertImage: []
  insertAttachment: []
  inspect: []
  search: []
}>()
</script>

<template>
  <header class="topbar">
    <NTooltip trigger="hover">
      <template #trigger>
        <div class="topbar__title">
          <NInput
            v-model:value="title"
            class="topbar-title-input"
            :bordered="false"
            :disabled="disabled"
            aria-label="文档标题"
            @update:value="emit('titleInput')"
            @blur="emit('commitTitle')"
            @keydown.enter.prevent="emit('commitTitle')"
          />
        </div>
      </template>
      {{ title }}
    </NTooltip>

    <div class="topbar__actions">
      <div class="save-status" :class="saveStatusClass">
        <span class="save-status__dot" aria-hidden="true"></span><span>{{ saveStatusText }}</span>
      </div>
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            class="topbar__icon-button"
            quaternary
            circle
            aria-label="新建子页面"
            :disabled="busy || disabled || !hasDocument"
            @click="emit('createChild')"
          >
            <template #icon
              ><NIcon :size="20"><Plus /></NIcon
            ></template>
          </NButton>
        </template>
        新建子页面
      </NTooltip>
      <NButton class="topbar__text-button" text :loading="preparingShare" @click="emit('share')"
        >分享</NButton
      >
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            class="topbar__icon-button"
            quaternary
            circle
            aria-label="插入图片"
            :disabled="disabled"
            @click="emit('insertImage')"
          >
            <template #icon
              ><NIcon :size="20"><ImagePlus /></NIcon
            ></template>
          </NButton>
        </template>
        插入图片
      </NTooltip>
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            class="topbar__icon-button"
            quaternary
            circle
            aria-label="插入附件"
            :disabled="disabled"
            @click="emit('insertAttachment')"
          >
            <template #icon
              ><NIcon :size="20"><Archive /></NIcon
            ></template>
          </NButton>
        </template>
        插入附件
      </NTooltip>
      <NTooltip trigger="hover">
        <template #trigger
          ><NButton class="topbar__icon-button" quaternary circle aria-label="评论"
            ><template #icon
              ><NIcon :size="20"><MessageSquare /></NIcon></template></NButton
        ></template>
        评论
      </NTooltip>
      <NTooltip trigger="hover">
        <template #trigger
          ><NButton class="topbar__icon-button" quaternary circle aria-label="更多"
            ><template #icon
              ><NIcon :size="20"><Ellipsis /></NIcon></template></NButton
        ></template>
        更多
      </NTooltip>
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            class="topbar__icon-button"
            quaternary
            circle
            aria-label="开发面板"
            @click="emit('inspect')"
            ><template #icon
              ><NIcon :size="19"><Share2 /></NIcon></template
          ></NButton>
        </template>
        开发面板
      </NTooltip>
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            class="topbar__icon-button"
            quaternary
            circle
            aria-label="搜索"
            @click="emit('search')"
            ><template #icon
              ><NIcon :size="21"><Search /></NIcon></template
          ></NButton>
        </template>
        搜索
      </NTooltip>
    </div>
  </header>
</template>
