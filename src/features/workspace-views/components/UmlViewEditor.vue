<script setup lang="ts">
import { computed } from 'vue'
import { parseMermaidFlowNodes, renameMermaidNode, type UmlViewPayload } from '@/models/workspace/workspaceView'
import MermaidPreview from './MermaidPreview.vue'
const props = defineProps<{ payload: UmlViewPayload }>()
const emit = defineEmits<{ update: [payload: UmlViewPayload] }>()
const nodes = computed(() => parseMermaidFlowNodes(props.payload.source))
function source(value: string) { emit('update', { ...props.payload, source: value }) }
function rename(id: string, label: string) { try { source(renameMermaidNode(props.payload.source, id, label)) } catch { /* source editor remains available */ } }
</script>
<template><div class="uml-view-editor"><aside><h3>语义节点</h3><label v-for="node in nodes" :key="node.id"><code>{{ node.id }}</code><input :value="node.label" @change="rename(node.id,($event.target as HTMLInputElement).value)" /></label><p v-if="!nodes.length">当前源码没有可语义编辑的受支持节点。</p></aside><main><MermaidPreview :source="payload.source" /><textarea class="uml-source" :value="payload.source" spellcheck="false" @input="source(($event.target as HTMLTextAreaElement).value)" /></main></div></template>
