import { ref, watch, type Ref } from 'vue'

import type { AppSettings } from '@/models/settings'

export type PasswordHasher = (value: string) => Promise<string>

export function useSensitiveAuthorization(
  settings: Ref<AppSettings>,
  hashPassword: PasswordHasher = sha256Hex,
) {
  const showSensitiveAuthModal = ref(false)
  const sensitiveAuthTitle = ref('敏感操作授权')
  const sensitiveAuthDescription = ref('')
  const sensitiveAuthPassword = ref('')
  const sensitiveAuthError = ref('')
  let resolver: ((authorized: boolean) => void) | null = null

  watch(showSensitiveAuthModal, (show) => {
    if (!show && resolver) cancelSensitiveAuthorization()
  })

  function requestSensitiveAuthorization(title: string, description: string): Promise<boolean> {
    if (
      !settings.value.sensitiveActionPasswordEnabled ||
      !settings.value.sensitiveActionPasswordHash
    ) {
      return Promise.resolve(true)
    }

    sensitiveAuthTitle.value = title
    sensitiveAuthDescription.value = description
    sensitiveAuthPassword.value = ''
    sensitiveAuthError.value = ''
    showSensitiveAuthModal.value = true

    return new Promise((resolve) => {
      resolver = resolve
    })
  }

  async function confirmSensitiveAuthorization(): Promise<void> {
    const password = sensitiveAuthPassword.value.trim()
    if (!password) {
      sensitiveAuthError.value = '请输入授权密码。'
      return
    }

    const hash = await hashPassword(password)
    if (hash !== settings.value.sensitiveActionPasswordHash) {
      sensitiveAuthError.value = '授权密码不正确。'
      sensitiveAuthPassword.value = ''
      return
    }

    resolveSensitiveAuthorization(true)
  }

  function cancelSensitiveAuthorization(): void {
    resolveSensitiveAuthorization(false)
  }

  function resolveSensitiveAuthorization(authorized: boolean): void {
    const pendingResolver = resolver
    resolver = null
    showSensitiveAuthModal.value = false
    sensitiveAuthPassword.value = ''
    sensitiveAuthError.value = ''
    pendingResolver?.(authorized)
  }

  return {
    showSensitiveAuthModal,
    sensitiveAuthTitle,
    sensitiveAuthDescription,
    sensitiveAuthPassword,
    sensitiveAuthError,
    requestSensitiveAuthorization,
    confirmSensitiveAuthorization,
    cancelSensitiveAuthorization,
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new globalThis.TextEncoder().encode(value)
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
