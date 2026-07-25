<script setup lang="ts">
import { computed } from 'vue'

import { splitHighlight } from '@/models/shared/searchHighlight'

const props = defineProps<{
  text: string
  query: string
}>()

const segments = computed(() => splitHighlight(props.text, props.query))
</script>

<template>
  <template v-for="(seg, i) in segments" :key="i">
    <mark v-if="seg.match" class="search-highlight">{{ seg.text }}</mark>
    <span v-else>{{ seg.text }}</span>
  </template>
</template>
