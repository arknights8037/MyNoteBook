<script setup lang="ts">
import { MousePointer2 } from '@lucide/vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'

import { NSelect } from '@/ui'
import type { AppSettings } from '@/models/settings/settings'
import { useSettingsSectionContext } from './settingsSectionContext'

const { settings, startupOptions, newDocumentOptions, update } = useSettingsSectionContext()
</script>

<template>
  <section id="settings-general" class="settings-section">
    <header class="settings-section__header">
      <span><MousePointer2 :size="18" /></span>
      <div>
        <h2>通用偏好</h2>
        <p>决定应用启动和日常操作的方式。</p>
      </div>
    </header>
    <div class="settings-card">
      <div class="settings-row">
        <span><strong>启动时打开</strong><small>选择进入知识库后的默认页面。</small></span>
        <NSelect
          :value="settings.startupBehavior"
          :options="startupOptions"
          @update:value="update('startupBehavior', $event as AppSettings['startupBehavior'])"
        />
      </div>
      <div class="settings-row">
        <span><strong>快捷新建位置</strong><small>使用快捷键新建页面时采用。</small></span>
        <NSelect
          :value="settings.newDocumentLocation"
          :options="newDocumentOptions"
          @update:value="
            update('newDocumentLocation', $event as AppSettings['newDocumentLocation'])
          "
        />
      </div>
      <div class="settings-row settings-row--switch">
        <span><strong>删除前确认</strong><small>移入回收站和彻底删除前显示确认窗口。</small></span>
        <SwitchRoot
          class="settings-switch"
          :model-value="settings.confirmBeforeDelete"
          @update:model-value="update('confirmBeforeDelete', $event)"
        >
          <SwitchThumb class="settings-switch__thumb" />
        </SwitchRoot>
      </div>
    </div>
  </section>
</template>
