import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useHomeKeyboardShortcuts } from './useHomeKeyboardShortcuts'
import { createDefaultAppSettings } from '@/models/settings'

describe('useHomeKeyboardShortcuts', () => {
  it('routes configured shortcuts to semantic actions', () => {
    const actions = {
      search: vi.fn(),
      newDocument: vi.fn(),
      save: vi.fn(),
      openSettings: vi.fn(),
      importDocument: vi.fn(),
    }
    const shortcuts = useHomeKeyboardShortcuts(ref(createDefaultAppSettings()), actions)
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
    vi.spyOn(event, 'preventDefault')

    shortcuts.handleGlobalKeydown(event)

    expect(actions.search).toHaveBeenCalledOnce()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('blocks developer shortcuts when developer mode is disabled', () => {
    const settings = ref(createDefaultAppSettings())
    const shortcuts = useHomeKeyboardShortcuts(settings, {
      search: vi.fn(),
      newDocument: vi.fn(),
      save: vi.fn(),
      openSettings: vi.fn(),
      importDocument: vi.fn(),
    })
    const event = new KeyboardEvent('keydown', { key: 'F12' })
    vi.spyOn(event, 'preventDefault')

    shortcuts.handleDeveloperToolKeydown(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})
