<script setup lang="ts">
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Laptop,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import type { LocalEnvironmentVariable } from '@/models/integrations/localEnvironment'
import { getLocalEnvironmentSnapshot } from '@/services/integrations/LocalEnvironmentService'

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const snapshot = ref<Awaited<ReturnType<typeof getLocalEnvironmentSnapshot>> | null>(null)
const loading = ref(false)
const error = ref('')
const query = ref('')
const activeCategory = ref('全部')
const expandedVariables = ref(new Set<string>())
const copiedName = ref('')

const categories = computed(() => [
  '全部',
  ...Array.from(new Set(snapshot.value?.variables.map((item) => item.category) ?? [])),
])
const filteredVariables = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  const limit = props.compact && !keyword ? 6 : Number.POSITIVE_INFINITY
  return (snapshot.value?.variables ?? [])
    .filter((item) => {
      if (activeCategory.value !== '全部' && item.category !== activeCategory.value) return false
      return (
        !keyword ||
        `${item.name} ${item.value} ${item.category}`.toLocaleLowerCase().includes(keyword)
      )
    })
    .slice(0, limit)
})

async function load(): Promise<void> {
  if (!native) {
    error.value = '本地环境仅可在 Tauri 桌面应用中读取。'
    return
  }
  loading.value = true
  error.value = ''
  try {
    snapshot.value = await getLocalEnvironmentSnapshot()
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    loading.value = false
  }
}

function pathSegments(item: LocalEnvironmentVariable): string[] {
  if (!item.isPathList) return [item.value]
  return item.value
    .split(item.name === 'PATHEXT' || item.value.includes(';') ? ';' : ':')
    .map((value) => value.trim())
    .filter(Boolean)
}

function toggleExpanded(name: string): void {
  const next = new Set(expandedVariables.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expandedVariables.value = next
}

async function copyVariable(item: LocalEnvironmentVariable): Promise<void> {
  await globalThis.navigator.clipboard.writeText(item.value)
  copiedName.value = item.name
  globalThis.setTimeout(() => {
    if (copiedName.value === item.name) copiedName.value = ''
  }, 1400)
}

onMounted(load)

defineExpose({ refresh: load })
</script>

<template>
  <section class="local-environment" :class="{ 'local-environment--compact': compact }">
    <header v-if="!compact" class="local-environment__header">
      <div class="local-environment__heading">
        <span><Laptop :size="21" /></span>
        <div>
          <h2>本地环境</h2>
          <p>快速确认当前设备、工具链路径与 myNoteBook 运行上下文。</p>
        </div>
      </div>
      <button type="button" :disabled="loading" aria-label="刷新本地环境" @click="load">
        <RefreshCw :size="15" :class="{ 'is-spinning': loading }" />刷新
      </button>
    </header>

    <div v-if="snapshot" class="local-environment__identity">
      <div>
        <Laptop :size="16" /><span
          ><small>设备</small><strong>{{ snapshot.hostName }}</strong></span
        >
      </div>
      <div>
        <TerminalSquare :size="16" /><span
          ><small>系统</small
          ><strong>{{ snapshot.operatingSystem }} · {{ snapshot.architecture }}</strong></span
        >
      </div>
      <div>
        <ShieldCheck :size="16" /><span
          ><small>可见范围</small><strong>{{ snapshot.variables.length }} 个安全变量</strong></span
        >
      </div>
    </div>

    <div v-if="snapshot && !compact" class="local-environment__toolbar">
      <label
        ><Search :size="14" /><input
          v-model="query"
          type="search"
          placeholder="搜索名称、路径或分组"
      /></label>
      <div role="tablist" aria-label="环境变量分组">
        <button
          v-for="category in categories"
          :key="category"
          type="button"
          role="tab"
          :aria-selected="activeCategory === category"
          :class="{ 'is-active': activeCategory === category }"
          @click="activeCategory = category"
        >
          {{ category }}
        </button>
      </div>
    </div>

    <p v-if="loading && !snapshot" class="local-environment__state">正在读取本机环境…</p>
    <p v-else-if="error" class="local-environment__state is-error">{{ error }}</p>
    <div v-else-if="snapshot" class="local-environment__variables">
      <article v-for="item in filteredVariables" :key="item.name">
        <button
          v-if="item.isPathList"
          type="button"
          class="local-environment__expand"
          :aria-label="`${expandedVariables.has(item.name) ? '收起' : '展开'} ${item.name}`"
          @click="toggleExpanded(item.name)"
        >
          <ChevronDown v-if="expandedVariables.has(item.name)" :size="14" />
          <ChevronRight v-else :size="14" />
        </button>
        <span v-else class="local-environment__bullet" />
        <div>
          <span
            ><strong>{{ item.name }}</strong
            ><small>{{ item.category }}</small></span
          >
          <code :title="item.value">{{ item.value }}</code>
          <ol v-if="expandedVariables.has(item.name)">
            <li v-for="segment in pathSegments(item)" :key="segment">
              <code>{{ segment }}</code>
            </li>
          </ol>
        </div>
        <button
          type="button"
          class="local-environment__copy"
          :aria-label="`复制 ${item.name}`"
          @click="copyVariable(item)"
        >
          <Check v-if="copiedName === item.name" :size="14" /><Clipboard v-else :size="14" />
        </button>
      </article>
      <p v-if="filteredVariables.length === 0" class="local-environment__state">
        没有匹配的环境变量。
      </p>
    </div>

    <footer v-if="!compact">
      <ShieldCheck :size="14" />
      仅展示预设白名单；API Key、Token、密码等敏感变量不会被读取。
    </footer>
  </section>
</template>
