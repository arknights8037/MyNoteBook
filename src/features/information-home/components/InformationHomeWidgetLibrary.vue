<script setup lang="ts">
import { Plus, X } from '@lucide/vue'

import type { InformationHomeWidgetType } from '@/models/home/informationHome'
import { INFORMATION_HOME_WIDGET_REGISTRY } from '../informationHomeWidgetRegistry'

const emit = defineEmits<{ add: [type: InformationHomeWidgetType]; close: [] }>()
</script>

<template>
  <aside class="dashboard-widget-library" aria-label="首页模块库">
    <header>
      <div><strong>首页模块</strong><small>模块数据独立于文档与普通看板</small></div>
      <button type="button" aria-label="关闭模块库" @click="emit('close')"><X :size="17" /></button>
    </header>
    <button
      v-for="widget in INFORMATION_HOME_WIDGET_REGISTRY"
      :key="widget.type"
      type="button"
      class="dashboard-widget-library__item"
      @click="emit('add', widget.type)"
    >
      <span
        ><strong>{{ widget.title }}</strong
        ><small>{{ widget.description }}</small></span
      ><Plus :size="17" />
    </button>
    <p>首页模块只读取已登记的本地来源；智能摘要不会执行邮件或网页中的指令。</p>
  </aside>
</template>
