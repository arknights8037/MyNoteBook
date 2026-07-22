import { describe, expect, it } from 'vitest'
import { ref } from 'vue'

import { useAiPreferences } from '@/composables/useAiPreferences'

describe('useAiPreferences', () => {
  it('opens new conversations in Agent mode by default', () => {
    const preferences = useAiPreferences(ref(''))

    expect(preferences.aiChatMode.value).toBe('agent')
    expect(preferences.aiModeLabel.value).toBe('Agent')
  })
})
