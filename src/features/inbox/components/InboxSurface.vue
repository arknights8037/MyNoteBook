<script setup lang="ts">
import { ArrowRight, PlugZap } from '@lucide/vue'
import { computed } from 'vue'

import type { InboxSection } from '@/models/workspace/workspaceSurface'
import SurfaceTitleBar from '@/features/workspace/components/SurfaceTitleBar.vue'
import { getWorkspaceSectionMeta } from '@/features/workspace/workspaceSections'
import EmailInboxPanel from './EmailInboxPanel.vue'
import RssInboxPanel from './RssInboxPanel.vue'
import UnifiedInboxPanel from './UnifiedInboxPanel.vue'
import ConnectorFailuresPanel from './ConnectorFailuresPanel.vue'
import ImInboxPanel from './ImInboxPanel.vue'

const props = defineProps<{ section: InboxSection; targetId?: string }>()
const emit = defineEmits<{ openConnections: [] }>()

const activeMeta = computed(() => getWorkspaceSectionMeta('inbox', props.section))
</script>

<template>
  <section class="inbox-surface" aria-label="收件箱">
    <SurfaceTitleBar :title="activeMeta.label" :icon="activeMeta.icon">
      <template #actions>
        <button type="button" @click="emit('openConnections')">
          <PlugZap :size="16" />连接与扩展<ArrowRight :size="14" />
        </button>
      </template>
    </SurfaceTitleBar>

    <div class="inbox-surface__content">
      <ConnectorFailuresPanel
        v-if="section === 'failures'"
        @open-connections="emit('openConnections')"
      />

      <UnifiedInboxPanel
        v-else-if="section === 'pending' || section === 'all'"
        :mode="section"
        @open-connections="emit('openConnections')"
      />

      <EmailInboxPanel
        v-else-if="section === 'email'"
        mode="email"
        :target-id="targetId"
        @open-connections="emit('openConnections')"
      />

      <RssInboxPanel
        v-else-if="section === 'rss'"
        mode="rss"
        :target-id="targetId"
        @open-connections="emit('openConnections')"
      />

      <ImInboxPanel
        v-else-if="section === 'messages'"
        mode="messages"
        @open-connections="emit('openConnections')"
      />
    </div>
  </section>
</template>
