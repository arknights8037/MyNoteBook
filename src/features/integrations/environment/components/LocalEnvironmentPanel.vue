<script setup lang="ts">
import {
  Boxes,
  Braces,
  Check,
  Clipboard,
  Code2,
  GitBranch,
  Laptop,
  Package,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  Wrench,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import type { LocalEnvironmentVariable, LocalRuntime } from '@/models/integrations/localEnvironment'
import { getLocalEnvironmentSnapshot } from '@/services/integrations/LocalEnvironmentService'

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const snapshot = ref<Awaited<ReturnType<typeof getLocalEnvironmentSnapshot>> | null>(null)
const loading = ref(false)
const error = ref('')
const copiedId = ref('')
const copyingId = ref('')
const copyError = ref('')

const availableRuntimes = computed(() =>
  (snapshot.value?.runtimes ?? []).filter((runtime) => runtime.available),
)

async function load(): Promise<void> {
  if (!native) {
    error.value = '核心运行环境仅可在 Tauri 桌面应用中检测。'
    return
  }
  loading.value = true
  error.value = ''
  copyError.value = ''
  try {
    snapshot.value = await getLocalEnvironmentSnapshot()
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    loading.value = false
  }
}

function runtimeIcon(runtime: LocalRuntime) {
  if (runtime.kind === '编程语言' || runtime.kind === '运行时') return Braces
  if (runtime.kind === '包管理器') return Package
  if (runtime.kind === '版本控制') return GitBranch
  if (runtime.kind === '容器工具') return Boxes
  if (runtime.kind === '构建工具') return Wrench
  return Code2
}

async function copyValue(id: string, value: string): Promise<void> {
  if (copyingId.value) return
  copyingId.value = id
  copyError.value = ''
  try {
    await globalThis.navigator.clipboard.writeText(value)
    copiedId.value = id
    globalThis.setTimeout(() => {
      if (copiedId.value === id) copiedId.value = ''
    }, 1400)
  } catch (value) {
    copyError.value =
      value instanceof Error ? `系统剪贴板写入失败：${value.message}` : '系统剪贴板写入失败。'
  } finally {
    copyingId.value = ''
  }
}

function copyVariable(item: LocalEnvironmentVariable): Promise<void> {
  return copyValue(item.name, item.value)
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
          <h2>核心运行环境</h2>
          <p>聚焦当前设备可直接调用的编程语言、包管理器与开发工具。</p>
        </div>
      </div>
      <button type="button" :disabled="loading" aria-label="刷新运行环境" @click="load">
        <RefreshCw :size="15" :class="{ 'is-spinning': loading }" />刷新
      </button>
    </header>

    <div v-if="snapshot && !compact" class="local-environment__identity">
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
        <Code2 :size="16" /><span
          ><small>默认命令行</small
          ><strong :title="snapshot.shell">{{ snapshot.shell }}</strong></span
        >
      </div>
    </div>

    <p v-if="loading && !snapshot" class="local-environment__state">正在检测核心工具…</p>
    <p v-else-if="error" class="local-environment__state is-error">{{ error }}</p>
    <template v-else-if="snapshot">
      <section class="local-environment__runtime-section" aria-label="已安装的核心运行环境">
        <header>
          <div>
            <strong>已检测到的运行环境</strong>
            <small>{{ availableRuntimes.length }} 项可直接调用</small>
          </div>
        </header>
        <div v-if="availableRuntimes.length" class="local-environment__runtimes">
          <article v-for="runtime in availableRuntimes" :key="runtime.id">
            <span><component :is="runtimeIcon(runtime)" :size="18" /></span>
            <div>
              <span
                ><strong>{{ runtime.name }}</strong
                ><small>{{ runtime.kind }}</small></span
              >
              <code :title="runtime.version">{{ runtime.version }}</code>
              <small :title="runtime.executable">{{ runtime.executable }}</small>
            </div>
            <button
              type="button"
              :aria-label="`复制 ${runtime.name} 路径`"
              :disabled="Boolean(copyingId)"
              @click="copyValue(runtime.id, runtime.executable)"
            >
              <Check v-if="copiedId === runtime.id" :size="14" />
              <Clipboard v-else :size="14" />
            </button>
          </article>
        </div>
        <p v-else class="local-environment__state">暂未检测到可直接调用的开发工具。</p>
      </section>

      <section v-if="!compact && snapshot.variables.length" class="local-environment__paths">
        <header>
          <div><strong>关键目录</strong><small>仅保留日常排查最常用的位置</small></div>
        </header>
        <div>
          <article v-for="item in snapshot.variables" :key="item.name">
            <span class="local-environment__bullet" />
            <div>
              <span
                ><strong>{{ item.label }}</strong
                ><small>{{ item.name }}</small></span
              >
              <code :title="item.value">{{ item.value }}</code>
            </div>
            <button
              type="button"
              :aria-label="`复制 ${item.label}`"
              :disabled="Boolean(copyingId)"
              @click="copyVariable(item)"
            >
              <Check v-if="copiedId === item.name" :size="14" />
              <Clipboard v-else :size="14" />
            </button>
          </article>
        </div>
      </section>
    </template>
    <p v-if="copyError" class="local-environment__clipboard-status is-error" role="alert">
      {{ copyError }}
    </p>
    <p
      v-else-if="copyingId"
      class="local-environment__clipboard-status"
      role="status"
      aria-live="polite"
    >
      正在写入系统剪贴板…
    </p>

    <footer v-if="!compact">
      <ShieldCheck :size="14" />
      仅执行固定的版本查询并读取关键目录白名单；不会扫描项目文件或敏感变量。
    </footer>
  </section>
</template>
