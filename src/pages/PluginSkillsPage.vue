<script setup lang="ts">
import { Blocks, Check, ChevronRight, Puzzle, Sparkles } from '@lucide/vue'

import { listBuiltinPlugins } from '@/plugins/pluginRegistry'

const plugins = listBuiltinPlugins()

const capabilityLabels: Record<string, string> = {
  'document:read': '读取内容',
  'document:write': '编辑内容',
  'document:export': '导出内容',
  'repository:read': '读取仓库',
  'repository:write': '写入仓库',
}
</script>

<template>
  <section class="plugin-skills-page" aria-label="插件技能">
    <header class="plugin-skills-page__header">
      <div>
        <span class="plugin-skills-page__eyebrow"><Sparkles :size="14" /> 扩展能力</span>
        <h1>插件技能</h1>
        <p>管理 Agent 可以调用的工具与知识库扩展。</p>
      </div>
      <div class="plugin-skills-page__summary">
        <strong>{{ plugins.length }}</strong>
        <span>已安装</span>
      </div>
    </header>

    <div class="plugin-skills-page__content">
      <div class="plugin-skills-page__section-heading">
        <span>内置插件</span>
        <small>随应用提供并在本地运行</small>
      </div>

      <article v-for="plugin in plugins" :key="plugin.id" class="plugin-skill-row">
        <div class="plugin-skill-row__icon"><Puzzle :size="20" /></div>
        <div class="plugin-skill-row__body">
          <div class="plugin-skill-row__title">
            <strong>{{ plugin.name }}</strong>
            <span>v{{ plugin.version }}</span>
          </div>
          <p>{{ plugin.description }}</p>
          <div class="plugin-skill-row__capabilities">
            <span v-for="capability in plugin.capabilities" :key="capability">
              <Check :size="12" />{{ capabilityLabels[capability] || capability }}
            </span>
          </div>
          <div class="plugin-skill-row__commands">
            <div v-for="command in plugin.commands" :key="command.id">
              <Blocks :size="15" />
              <span><strong>{{ command.title }}</strong><small>{{ command.description }}</small></span>
              <ChevronRight :size="15" />
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
