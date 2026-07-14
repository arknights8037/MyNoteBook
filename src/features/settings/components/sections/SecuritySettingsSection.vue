<script setup lang="ts">
import { ShieldCheck } from '@lucide/vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'

import { NInput } from '@/ui'
import { useSettingsSectionContext } from './settingsSectionContext'

const {
  settings,
  sensitivePasswordDraft,
  update,
  updateSensitivePassword,
  updateSensitiveAuthorizationEnabled,
} = useSettingsSectionContext()
</script>

<template>
  <section id="settings-security" class="settings-section">
    <header class="settings-section__header">
      <span><ShieldCheck :size="18" /></span>
      <div>
        <h2>敏感操作授权</h2>
        <p>删除、恢复、导入导出和数据迁移前可要求输入授权密码。</p>
      </div>
    </header>
    <div class="settings-card">
      <div class="settings-row settings-row--switch">
        <span
          ><strong>启用密码授权</strong
          ><small>设置密码后，敏感动作会先要求输入授权密码。</small></span
        >
        <SwitchRoot
          class="settings-switch"
          :model-value="settings.sensitiveActionPasswordEnabled"
          :disabled="!settings.sensitiveActionPasswordHash"
          @update:model-value="updateSensitiveAuthorizationEnabled($event)"
        >
          <SwitchThumb class="settings-switch__thumb" />
        </SwitchRoot>
      </div>
      <div class="settings-row">
        <span
          ><strong>授权密码</strong><small>可随时输入新密码覆盖；留空会关闭密码授权。</small></span
        >
        <NInput
          :value="sensitivePasswordDraft"
          type="password"
          placeholder="输入自定义授权密码"
          autocomplete="new-password"
          @update:value="updateSensitivePassword"
        />
      </div>
      <div class="settings-row settings-row--switch">
        <span
          ><strong>允许开发模式</strong
          ><small>默认关闭。关闭时会拦截 F12 和开发者工具快捷键。</small></span
        >
        <SwitchRoot
          class="settings-switch"
          :model-value="settings.allowDeveloperMode"
          @update:model-value="update('allowDeveloperMode', $event)"
        >
          <SwitchThumb class="settings-switch__thumb" />
        </SwitchRoot>
      </div>
    </div>
  </section>
</template>
