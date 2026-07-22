import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useSensitiveAuthorization } from '@/composables/useSensitiveAuthorization'
import { createDefaultAppSettings } from '@/models/settings/settings'

describe('useSensitiveAuthorization', () => {
  it('authorizes immediately when password protection is disabled', async () => {
    const authorization = useSensitiveAuthorization(ref(createDefaultAppSettings()))

    await expect(authorization.requestSensitiveAuthorization('导出', '写入文件')).resolves.toBe(
      true,
    )
    expect(authorization.showSensitiveAuthModal.value).toBe(false)
  })

  it('keeps password verification and modal state in one workflow', async () => {
    const settings = createDefaultAppSettings()
    settings.sensitiveActionPasswordEnabled = true
    settings.sensitiveActionPasswordHash = 'expected-hash'
    const hasher = vi.fn(async (value: string) => `${value}-hash`)
    const authorization = useSensitiveAuthorization(ref(settings), hasher)
    const result = authorization.requestSensitiveAuthorization('导出', '写入文件')

    authorization.sensitiveAuthPassword.value = 'wrong'
    await authorization.confirmSensitiveAuthorization()
    expect(authorization.sensitiveAuthError.value).toBe('授权密码不正确。')

    authorization.sensitiveAuthPassword.value = 'expected'
    await authorization.confirmSensitiveAuthorization()
    await expect(result).resolves.toBe(true)
    expect(authorization.showSensitiveAuthModal.value).toBe(false)
  })

  it('resolves a pending request as rejected when the modal closes externally', async () => {
    const settings = createDefaultAppSettings()
    settings.sensitiveActionPasswordEnabled = true
    settings.sensitiveActionPasswordHash = 'hash'
    const authorization = useSensitiveAuthorization(ref(settings))
    const result = authorization.requestSensitiveAuthorization('导入', '创建页面')

    await nextTick()
    authorization.showSensitiveAuthModal.value = false
    await nextTick()

    await expect(result).resolves.toBe(false)
  })
})
