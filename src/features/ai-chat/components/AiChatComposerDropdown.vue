<script setup lang="ts">
import { Check, ChevronDown } from '@lucide/vue'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'

export interface AiChatComposerDropdownOption {
  value: string
  label: string
  description?: string
}

const props = defineProps<{
  options: AiChatComposerDropdownOption[]
  selected: string
  triggerLabel: string
  triggerClass?: string
  menuClass?: string
}>()

const emit = defineEmits<{
  select: [value: string]
}>()
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child>
      <button type="button" class="ai-chat-selector" :class="props.triggerClass">
        <span>{{ triggerLabel }}</span><ChevronDown :size="13" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        class="ai-chat-menu"
        :class="props.menuClass"
        align="start"
        :side-offset="6"
      >
        <DropdownMenuItem
          v-for="option in options"
          :key="option.value"
          class="ai-chat-menu__item"
          :class="{ 'ai-chat-menu__item--active': selected === option.value }"
          @select="emit('select', option.value)"
        >
          <span class="ai-chat-menu__item-copy"
            ><strong>{{ option.label }}</strong
            ><small v-if="option.description">{{ option.description }}</small></span
          >
          <Check v-if="selected === option.value" :size="15" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
