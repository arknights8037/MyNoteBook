<script setup lang="ts">
import { Database, FolderOpen } from '@lucide/vue'

import { NButton, NIcon } from '@/ui'
import { useSettingsSectionContext } from './settingsSectionContext'

const { settings, dataBusy, currentDataDirectory, chooseDataDirectory, restoreDataDirectory } =
  useSettingsSectionContext()
</script>

<template>
  <section id="settings-data" class="settings-section">
    <header class="settings-section__header">
      <span><Database :size="18" /></span>
      <div>
        <h2>数据存储</h2>
        <p>知识库数据库和受管文件均保存在本机。</p>
      </div>
    </header>
    <div class="settings-card">
      <div class="settings-row settings-row--data">
        <span
          ><strong>当前存储位置</strong
          ><small class="settings-path" :title="currentDataDirectory">{{
            currentDataDirectory
          }}</small
          ><em>切换会迁移数据库、附件、技能、MCP 配置与受管交付文件，并整体备份目标原有数据。</em></span
        >
        <div class="settings-row__actions">
          <NButton secondary :loading="dataBusy" @click="chooseDataDirectory"
            ><template #icon
              ><NIcon :size="15"><FolderOpen /></NIcon></template
            >更改位置</NButton
          >
          <NButton
            v-if="settings.dataDirectory"
            quaternary
            :disabled="dataBusy"
            @click="restoreDataDirectory"
            >恢复默认</NButton
          >
        </div>
      </div>
    </div>
  </section>
</template>
