<script setup lang="ts">
import { Check, ChevronDown } from '@lucide/vue'
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui'
import { computed, useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })

interface SelectOption {
  label: string
  value: string
}

const props = withDefaults(
  defineProps<{
    value?: string
    options?: SelectOption[]
    size?: 'small' | 'medium'
    placeholder?: string
    disabled?: boolean
  }>(),
  {
    value: '',
    options: () => [],
    size: 'medium',
    placeholder: '请选择',
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:value': [value: string]
}>()

const attrs = useAttrs()
const selectedLabel = computed(
  () =>
    props.options.find((option) => option.value === props.value)?.label ??
    (props.value || props.placeholder),
)

function handleValue(value: unknown): void {
  if (typeof value === 'string') emit('update:value', value)
}
</script>

<template>
  <SelectRoot :model-value="value" :disabled="disabled" @update:model-value="handleValue">
    <SelectTrigger
      v-bind="attrs"
      class="ui-select"
      :class="`ui-select--${size}`"
      :disabled="disabled"
    >
      <span class="ui-select__value"
        ><SelectValue :placeholder="placeholder">{{ selectedLabel }}</SelectValue></span
      >
      <ChevronDown :size="14" />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent class="ui-select-content" position="popper" :side-offset="5">
        <SelectViewport class="ui-select-viewport">
          <SelectItem
            v-for="option in options"
            :key="option.value"
            class="ui-select-item"
            :value="option.value"
          >
            <SelectItemText>{{ option.label }}</SelectItemText>
            <SelectItemIndicator class="ui-select-item__indicator"
              ><Check :size="13"
            /></SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
