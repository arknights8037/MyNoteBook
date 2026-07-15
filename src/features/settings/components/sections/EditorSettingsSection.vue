<script setup lang="ts">
import { RotateCcw, Type } from '@lucide/vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'

import { NButton, NIcon, NSelect } from '@/ui'
import type { AppSettings } from '@/models/settings'
import { useSettingsSectionContext } from './settingsSectionContext'

const {
  settings,
  widthOptions,
  fontSizeOptions,
  lineHeightOptions,
  chineseFontSelectOptions,
  westernFontSelectOptions,
  jumpAidOptions,
  jumpAidPositionOptions,
  jumpAidMaxLevelOptions,
  autosaveOptions,
  blockCopyOptions,
  update,
  updateFontFamily,
  resetFontFamily,
} = useSettingsSectionContext()
</script>

<template>
  <section id="settings-editor" class="settings-section">
    <header class="settings-section__header">
      <span><Type :size="18" /></span>
      <div>
        <h2>编辑器</h2>
        <p>调整阅读密度、保存和块操作。</p>
      </div>
    </header>
    <div class="settings-card">
      <div class="settings-row">
        <span><strong>正文宽度</strong><small>只影响文章内容，不影响侧栏。</small></span
        ><NSelect
          :value="settings.contentWidth"
          :options="widthOptions"
          @update:value="update('contentWidth', $event as AppSettings['contentWidth'])"
        />
      </div>
      <div class="settings-row">
        <span><strong>正文字号</strong><small>标题会按比例保持层级。</small></span
        ><NSelect
          :value="settings.fontSize"
          :options="fontSizeOptions"
          @update:value="update('fontSize', $event as AppSettings['fontSize'])"
        />
      </div>
      <div class="settings-row">
        <span><strong>正文行距</strong><small>调整长文档的阅读节奏。</small></span
        ><NSelect
          :value="settings.lineHeight"
          :options="lineHeightOptions"
          @update:value="update('lineHeight', $event as AppSettings['lineHeight'])"
        />
      </div>
      <div class="settings-row settings-row--font">
        <span><strong>中文字体</strong><small>从系统字体中选择，不影响公式字段。</small></span>
        <div class="settings-font-control">
          <NSelect
            class="settings-font-select"
            :value="settings.chineseFontFamily"
            :options="chineseFontSelectOptions"
            @update:value="updateFontFamily('chineseFontFamily', $event)"
          />
          <NButton
            quaternary
            circle
            aria-label="恢复默认中文字体"
            @click="resetFontFamily('chineseFontFamily')"
            ><template #icon
              ><NIcon :size="14"><RotateCcw /></NIcon></template
          ></NButton>
        </div>
      </div>
      <div class="settings-row settings-row--font">
        <span
          ><strong>西文字体</strong
          ><small>拉丁字符优先使用该字体，中文仍回落到中文字体。</small></span
        >
        <div class="settings-font-control">
          <NSelect
            class="settings-font-select"
            :value="settings.westernFontFamily"
            :options="westernFontSelectOptions"
            @update:value="updateFontFamily('westernFontFamily', $event)"
          />
          <NButton
            quaternary
            circle
            aria-label="恢复默认西文字体"
            @click="resetFontFamily('westernFontFamily')"
            ><template #icon
              ><NIcon :size="14"><RotateCcw /></NIcon></template
          ></NButton>
        </div>
      </div>
      <div class="settings-row">
        <span
          ><strong>跳转辅助工具</strong
          ><small>在文档右侧显示锚点或大纲，快速跳到标题。</small></span
        ><NSelect
          :value="settings.jumpAid"
          :options="jumpAidOptions"
          @update:value="update('jumpAid', $event as AppSettings['jumpAid'])"
        />
      </div>
      <div class="settings-row">
        <span
          ><strong>辅助显示位置</strong
          ><small>文档锚点和文档大纲都可显示在文章左侧或右侧。</small></span
        ><NSelect
          :value="settings.jumpAidPosition"
          :options="jumpAidPositionOptions"
          @update:value="update('jumpAidPosition', $event as AppSettings['jumpAidPosition'])"
        />
      </div>
      <div class="settings-row">
        <span
          ><strong>目录显示级别</strong
          ><small>大纲显示到所选层级；锚点只显示所选层级的标题。</small></span
        ><NSelect
          :value="String(settings.jumpAidMaxLevel)"
          :options="jumpAidMaxLevelOptions"
          @update:value="
            update('jumpAidMaxLevel', Number($event) as AppSettings['jumpAidMaxLevel'])
          "
        />
      </div>
      <div class="settings-row">
        <span><strong>自动保存</strong><small>停止输入多久后写入知识库。</small></span
        ><NSelect
          :value="String(settings.autosaveDelay)"
          :options="autosaveOptions"
          @update:value="update('autosaveDelay', Number($event))"
        />
      </div>
      <div class="settings-row">
        <span><strong>复制当前块</strong><small>立即在下方重复，或保留至粘贴。</small></span
        ><NSelect
          :value="settings.blockCopyBehavior"
          :options="blockCopyOptions"
          @update:value="update('blockCopyBehavior', $event as AppSettings['blockCopyBehavior'])"
        />
      </div>
      <div class="settings-row settings-row--switch">
        <span><strong>拼写检查</strong><small>使用系统词典标记可能的拼写错误。</small></span
        ><SwitchRoot
          class="settings-switch"
          :model-value="settings.spellcheck"
          @update:model-value="update('spellcheck', $event)"
          ><SwitchThumb class="settings-switch__thumb"
        /></SwitchRoot>
      </div>
      <div class="settings-row settings-row--switch">
        <span><strong>显示块控件</strong><small>鼠标经过文章块时显示拖拽手柄。</small></span
        ><SwitchRoot
          class="settings-switch"
          :model-value="settings.showBlockHandles"
          @update:model-value="update('showBlockHandles', $event)"
          ><SwitchThumb class="settings-switch__thumb"
        /></SwitchRoot>
      </div>
    </div>
  </section>
</template>
