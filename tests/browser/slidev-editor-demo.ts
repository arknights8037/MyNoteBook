import { createApp, h, ref } from 'vue'

import SlidesViewEditor from '@/features/workspace-views/components/SlidesViewEditor.vue'
import { createDefaultSlidevSource } from '@/models/workspace/slidevDeck'
import type { SlidesViewPayload } from '@/models/workspace/workspaceView'
import '@/styles/global.css'

let sequence = 0
const payload = ref<SlidesViewPayload>({
  type: 'slides',
  format: 'slidev',
  source: createDefaultSlidevSource((prefix) => `${prefix}-qa-${++sequence}`, 'Slidev 可视化演示'),
  assetIds: [],
})

createApp({
  setup() {
    return () => h(SlidesViewEditor, {
      payload: payload.value,
      onUpdate: (value: SlidesViewPayload) => { payload.value = value },
    })
  },
}).mount('#app')
