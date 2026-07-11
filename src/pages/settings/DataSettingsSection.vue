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
        <p>知识库保存在本机 SQLite 文件中。</p>
      </div>
    </header>
    <div class="settings-card">
      <div class="settings-row settings-row--data">
        <span
          ><strong>当前存储位置</strong
          ><small class="settings-path" :title="currentDataDirectory">{{
            currentDataDirectory
          }}</small
          ><em>切换时会先备份目标数据库，再复制当前知识库。</em></span
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
