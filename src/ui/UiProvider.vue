<script setup lang="ts">
import {
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
  ConfigProvider,
  ToastDescription,
  ToastProvider,
  ToastRoot,
  ToastViewport,
  TooltipProvider,
} from 'reka-ui'
import { onBeforeUnmount, provide, ref } from 'vue'

import {
  dialogServiceKey,
  messageServiceKey,
  type DialogOptions,
  type DialogService,
  type MessageService,
} from './services'

interface ToastMessage {
  id: number
  text: string
  type: 'success' | 'error'
  open: boolean
}

const messages = ref<ToastMessage[]>([])
const alertOpen = ref(false)
const alertOptions = ref<DialogOptions | null>(null)
let nextToastId = 0
const toastTimers = new Map<number, ReturnType<typeof globalThis.setTimeout>>()
const MAX_VISIBLE_TOASTS = 4
const TOAST_LIFETIME_MS = 3200

function notify(type: ToastMessage['type'], text: string): void {
  const id = ++nextToastId
  messages.value.push({ id, text, type, open: true })
  while (messages.value.length > MAX_VISIBLE_TOASTS) {
    removeToast(messages.value[0]!.id)
  }
  toastTimers.set(
    id,
    globalThis.setTimeout(() => removeToast(id), TOAST_LIFETIME_MS),
  )
}

function removeToast(id: number): void {
  const timer = toastTimers.get(id)
  if (timer) globalThis.clearTimeout(timer)
  toastTimers.delete(id)
  messages.value = messages.value.filter((message) => message.id !== id)
}

const messageService: MessageService = {
  success: (text) => notify('success', text),
  error: (text) => notify('error', text),
}

const dialogService: DialogService = {
  warning: (options) => {
    if (alertOptions.value && alertOptions.value !== options) {
      alertOptions.value.onClose?.()
    }
    alertOptions.value = options
    alertOpen.value = true
  },
}

function handleAlertOpen(value: boolean): void {
  alertOpen.value = value
  if (!value && alertOptions.value) {
    const options = alertOptions.value
    alertOptions.value = null
    options.onClose?.()
  }
}

function resolveAlert(positive: boolean): void {
  const options = alertOptions.value
  alertOptions.value = null
  alertOpen.value = false
  if (positive) options?.onPositiveClick?.()
  else options?.onNegativeClick?.()
}

onBeforeUnmount(() => {
  for (const timer of toastTimers.values()) globalThis.clearTimeout(timer)
  toastTimers.clear()
  alertOptions.value?.onClose?.()
  alertOptions.value = null
})

provide(messageServiceKey, messageService)
provide(dialogServiceKey, dialogService)
</script>

<template>
  <ConfigProvider>
    <TooltipProvider :delay-duration="280">
      <ToastProvider :duration="2600">
        <slot />
        <ToastRoot
          v-for="toast in messages"
          :key="toast.id"
          v-model:open="toast.open"
          class="ui-toast"
          :class="`ui-toast--${toast.type}`"
          @update:open="!$event && removeToast(toast.id)"
        >
          <ToastDescription>{{ toast.text }}</ToastDescription>
        </ToastRoot>
        <ToastViewport class="ui-toast-viewport" />
      </ToastProvider>
    </TooltipProvider>

    <AlertDialogRoot :open="alertOpen" @update:open="handleAlertOpen">
      <AlertDialogPortal>
        <AlertDialogOverlay class="ui-dialog-overlay" />
        <AlertDialogContent v-if="alertOptions" class="ui-alert-dialog">
          <AlertDialogTitle class="ui-alert-dialog__title">{{
            alertOptions.title
          }}</AlertDialogTitle>
          <AlertDialogDescription class="ui-alert-dialog__description">{{
            alertOptions.content
          }}</AlertDialogDescription>
          <div class="ui-alert-dialog__actions">
            <button type="button" class="ui-button ui-button--medium" @click="resolveAlert(false)">
              {{ alertOptions.negativeText ?? '取消' }}
            </button>
            <button
              type="button"
              class="ui-button ui-button--medium ui-button--primary"
              @click="resolveAlert(true)"
            >
              {{ alertOptions.positiveText ?? '确定' }}
            </button>
          </div>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialogRoot>
  </ConfigProvider>
</template>
