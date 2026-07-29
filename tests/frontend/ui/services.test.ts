import { describe, expect, it, vi } from 'vitest'

import { requestDialogConfirmation, type DialogOptions } from '@/ui/services'

describe('requestDialogConfirmation', () => {
  it.each([
    ['onPositiveClick', true],
    ['onNegativeClick', false],
    ['onClose', false],
  ] as const)('settles %s as %s', async (callback, expected) => {
    let rendered: DialogOptions | null = null
    const promise = requestDialogConfirmation(
      { warning: vi.fn((options) => (rendered = options)) },
      { title: '确认', content: '继续吗？' },
    )

    rendered?.[callback]?.()

    await expect(promise).resolves.toBe(expected)
  })

  it('ignores duplicate dialog callbacks', async () => {
    let rendered: DialogOptions | null = null
    const promise = requestDialogConfirmation(
      { warning: (options) => (rendered = options) },
      { title: '确认', content: '继续吗？' },
    )

    rendered?.onPositiveClick?.()
    rendered?.onClose?.()

    await expect(promise).resolves.toBe(true)
  })
})
