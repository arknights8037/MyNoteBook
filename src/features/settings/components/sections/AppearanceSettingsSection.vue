<script setup lang="ts">
import { Check, Monitor, Palette } from '@lucide/vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'

import { useSettingsSectionContext } from './settingsSectionContext'

const { settings, themeCards, updateTheme, update } = useSettingsSectionContext()
</script>

<template>
  <section id="settings-appearance" class="settings-section">
    <header class="settings-section__header">
      <span><Palette :size="18" /></span>
      <div>
        <h2>外观</h2>
        <p>主题会跟随选择即时切换。</p>
      </div>
    </header>
    <div class="settings-card">
      <div class="settings-row settings-row--stacked">
        <span><strong>颜色主题</strong><small>选择后立即应用，并保存在本机设置中。</small></span>
        <div class="theme-options" role="radiogroup" aria-label="颜色主题">
          <button
            v-for="option in themeCards"
            :key="option.value"
            type="button"
            role="radio"
            :aria-checked="settings.theme === option.value"
            :class="{ 'theme-option--active': settings.theme === option.value }"
            class="theme-option"
            @click="updateTheme(option.value)"
          >
            <span
              class="theme-option__preview"
              :style="{
                backgroundColor: option.theme.colors.background.app,
                borderColor: option.theme.colors.border.default,
              }"
              aria-hidden="true"
            >
              <span
                class="theme-option__sidebar"
                :style="{ backgroundColor: option.theme.colors.background.sidebar }"
              ></span>
              <span
                class="theme-option__editor"
                :style="{
                  backgroundColor: option.theme.colors.background.editor,
                  color: option.theme.colors.text.primary,
                }"
              >
                <span :style="{ backgroundColor: option.theme.colors.text.primary }"></span>
                <span :style="{ backgroundColor: option.theme.colors.text.secondary }"></span>
              </span>
              <span
                class="theme-option__accent"
                :style="{ backgroundColor: option.theme.colors.accent.primary }"
              ></span>
              <span
                class="theme-option__agent"
                :style="{ backgroundColor: option.theme.colors.agent.accent }"
              ></span>
            </span>
            <span class="theme-option__body">
              <strong
                ><Monitor v-if="option.value === 'system'" :size="14" />{{ option.label }}</strong
              >
              <small>{{ option.resolvedLabel }}</small>
            </span>
            <Check v-if="settings.theme === option.value" :size="15" />
          </button>
        </div>
      </div>
      <div class="settings-row settings-row--switch">
        <span><strong>减少动态效果</strong><small>关闭平滑滚动和非必要过渡动画。</small></span>
        <SwitchRoot
          class="settings-switch"
          :model-value="settings.reduceMotion"
          @update:model-value="update('reduceMotion', $event)"
          ><SwitchThumb class="settings-switch__thumb"
        /></SwitchRoot>
      </div>
    </div>
  </section>
</template>
