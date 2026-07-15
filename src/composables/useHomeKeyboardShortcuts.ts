import type { Ref } from 'vue'

import { matchesShortcut, type AppSettings } from '@/models/settings'

type BrowserKeyboardEvent = InstanceType<typeof globalThis.KeyboardEvent>

interface HomeShortcutActions {
  openAgent: () => void
  search: () => void
  newDocument: () => void
  save: () => void
  openSettings: () => void
  importDocument: () => void
}

export function useHomeKeyboardShortcuts(
  settings: Ref<AppSettings>,
  actions: HomeShortcutActions,
) {
  function handleGlobalKeydown(event: BrowserKeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      actions.openAgent()
      return
    }

    const shortcuts = settings.value.shortcuts
    const match = (
      action: keyof HomeShortcutActions,
      shortcut: string,
    ): boolean => {
      if (!matchesShortcut(event, shortcut)) return false
      event.preventDefault()
      actions[action]()
      return true
    }

    if (match('search', shortcuts.search)) return
    if (match('newDocument', shortcuts.newDocument)) return
    if (match('save', shortcuts.save)) return
    if (match('openSettings', shortcuts.openSettings)) return
    match('importDocument', shortcuts.importDocument)
  }

  function handleDeveloperToolKeydown(event: BrowserKeyboardEvent): void {
    if (settings.value.allowDeveloperMode || !isDeveloperToolShortcut(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  return { handleGlobalKeydown, handleDeveloperToolKeydown }
}

function isDeveloperToolShortcut(event: BrowserKeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  return (
    key === 'f12' ||
    ((event.ctrlKey || event.metaKey) && event.shiftKey && (key === 'i' || key === 'j')) ||
    ((event.ctrlKey || event.metaKey) && key === 'u')
  )
}
