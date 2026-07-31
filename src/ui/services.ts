import { inject, type InjectionKey } from 'vue'

export interface MessageService {
  success: (text: string) => void
  warning?: (text: string) => void
  error: (text: string) => void
}

export interface DialogOptions {
  title: string
  content: string
  positiveText?: string
  negativeText?: string
  onPositiveClick?: () => void
  onNegativeClick?: () => void
  onClose?: () => void
}

export interface DialogService {
  warning: (options: DialogOptions) => void
}

export const messageServiceKey: InjectionKey<MessageService> = Symbol('message-service')
export const dialogServiceKey: InjectionKey<DialogService> = Symbol('dialog-service')

const noopMessageService: MessageService = {
  success: () => undefined,
  warning: () => undefined,
  error: () => undefined,
}

const noopDialogService: DialogService = {
  warning: () => undefined,
}

export function useMessage(): MessageService {
  return inject(messageServiceKey, noopMessageService)
}

export function useDialog(): DialogService {
  return inject(dialogServiceKey, noopDialogService)
}

export function requestDialogConfirmation(
  dialog: DialogService,
  options: Omit<DialogOptions, 'onPositiveClick' | 'onNegativeClick' | 'onClose'>,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (confirmed: boolean): void => {
      if (settled) return
      settled = true
      resolve(confirmed)
    }

    dialog.warning({
      ...options,
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    })
  })
}
