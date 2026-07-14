<script setup lang="ts">
import { Keyboard, RotateCcw } from '@lucide/vue'

import { NButton, NIcon } from '@/ui'
import { DEFAULT_SHORTCUTS } from '@/models/settings'
import { useSettingsSectionContext } from './settingsSectionContext'

const {
  settings,
  recordingShortcut,
  shortcutRows,
  shortcutConflicts,
  startRecording,
  recordShortcut,
  updateShortcut,
} = useSettingsSectionContext()
</script>

<template>
  <section id="settings-shortcuts" class="settings-section">
    <header class="settings-section__header">
      <span><Keyboard :size="18" /></span>
      <div>
        <h2>快捷键</h2>
        <p>点击组合键后，直接按下新的按键组合。</p>
      </div>
    </header>
    <div class="settings-card settings-shortcuts">
      <div
        v-for="row in shortcutRows"
        :key="row.action"
        class="settings-row settings-row--shortcut"
      >
        <span
          ><strong>{{ row.label }}</strong
          ><small>{{ row.description }}</small
          ><em
            v-if="shortcutConflicts[settings.shortcuts[row.action].toLocaleLowerCase()] > 1"
            class="shortcut-conflict"
            >与其他操作冲突</em
          ></span
        >
        <div class="shortcut-control">
          <button
            type="button"
            class="shortcut-recorder"
            :class="{ 'shortcut-recorder--recording': recordingShortcut === row.action }"
            @click="startRecording(row.action, $event)"
            @keydown="recordShortcut(row.action, $event)"
          >
            {{ recordingShortcut === row.action ? '请按组合键…' : settings.shortcuts[row.action] }}
          </button>
          <NButton
            quaternary
            circle
            :aria-label="`恢复${row.label}默认快捷键`"
            :disabled="settings.shortcuts[row.action] === DEFAULT_SHORTCUTS[row.action]"
            @click="updateShortcut(row.action, DEFAULT_SHORTCUTS[row.action])"
            ><template #icon
              ><NIcon :size="14"><RotateCcw /></NIcon></template
          ></NButton>
        </div>
      </div>
    </div>
  </section>
</template>
