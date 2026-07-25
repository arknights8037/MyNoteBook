import { computed, nextTick, ref, type Ref } from 'vue'

import type { AgentExplicitTarget, AgentTargetOption } from '@/models/agent/agentTarget'
import {
  filterAgentSlashCommands,
  resolveAgentSlashCommand,
  type AgentSlashCommand,
} from '@/models/agent/agentSlashCommand'

export interface ComposerMenusConfig {
  prompt: Ref<string>
  targetOptions: Ref<AgentTargetOption[]>
  explicitTargets: Ref<AgentExplicitTarget[]>
  focusComposer: () => void
}

export function useComposerMenus(config: ComposerMenusConfig) {
  const slashSelectedIndex = ref(0)
  const slashMenuDismissed = ref(false)
  const targetSelectedIndex = ref(0)
  const targetMenuDismissed = ref(false)

  const slashCommands = computed(() =>
    slashMenuDismissed.value ? [] : filterAgentSlashCommands(config.prompt.value),
  )
  const activeSlashCommand = computed(
    () => resolveAgentSlashCommand(config.prompt.value)?.command ?? null,
  )
  const targetQuery = computed(() => {
    const match = config.prompt.value.match(/(?:^|\s)@([^\s@]*)$/)
    return match?.[1]?.toLocaleLowerCase() ?? null
  })
  const filteredTargetOptions = computed(() => {
    if (targetMenuDismissed.value || targetQuery.value === null) return []
    return config.targetOptions.value
      .filter(
        (option) =>
          !config.explicitTargets.value.some(
            (target) => target.kind === option.kind && target.id === option.id,
          ),
      )
      .filter((option) =>
        `${option.title} ${option.subtitle}`.toLocaleLowerCase().includes(targetQuery.value ?? ''),
      )
      .slice(0, 8)
  })

  function resetMenus(): void {
    slashMenuDismissed.value = false
    slashSelectedIndex.value = 0
    targetMenuDismissed.value = false
    targetSelectedIndex.value = 0
  }

  /**
   * Handles keyboard navigation for both menus.
   * Returns true if the event was consumed (caller should not process further).
   */
  function handleMenuKeydown(
    event: KeyboardEvent,
    callbacks: {
      onSelectTarget: (target: AgentTargetOption) => void
      onSelectSlashCommand: (command: AgentSlashCommand) => void
    },
  ): boolean {
    if (filteredTargetOptions.value.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        targetSelectedIndex.value =
          (targetSelectedIndex.value + direction + filteredTargetOptions.value.length) %
          filteredTargetOptions.value.length
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        targetMenuDismissed.value = true
        return true
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        const target = filteredTargetOptions.value[targetSelectedIndex.value]
        if (target) callbacks.onSelectTarget(target)
        return true
      }
    }
    if (slashCommands.value.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        slashSelectedIndex.value =
          (slashSelectedIndex.value + direction + slashCommands.value.length) %
          slashCommands.value.length
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        slashMenuDismissed.value = true
        return true
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        const command = slashCommands.value[slashSelectedIndex.value]
        if (command) callbacks.onSelectSlashCommand(command)
        return true
      }
    }
    return false
  }

  function dismissTargetMenu(): void {
    targetMenuDismissed.value = true
    void nextTick(config.focusComposer)
  }

  function openTargetMenu(currentPrompt: string): string {
    const separator = currentPrompt && !currentPrompt.endsWith(' ') ? ' ' : ''
    targetMenuDismissed.value = false
    targetSelectedIndex.value = 0
    void nextTick(config.focusComposer)
    return `${currentPrompt}${separator}@`
  }

  function dismissSlashMenu(): void {
    slashMenuDismissed.value = true
    void nextTick(config.focusComposer)
  }

  function openSlashMenu(): void {
    slashMenuDismissed.value = false
    slashSelectedIndex.value = 0
    void nextTick(config.focusComposer)
  }

  return {
    slashSelectedIndex,
    slashMenuDismissed,
    targetSelectedIndex,
    targetMenuDismissed,
    slashCommands,
    activeSlashCommand,
    targetQuery,
    filteredTargetOptions,
    resetMenus,
    handleMenuKeydown,
    dismissTargetMenu,
    openTargetMenu,
    dismissSlashMenu,
    openSlashMenu,
  }
}
