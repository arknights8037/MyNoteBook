<script setup lang="ts">
import { open } from '@tauri-apps/plugin-dialog'
import {
  Cable,
  CheckCircle2,
  ClipboardPaste,
  FileJson,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  TriangleAlert,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import type { McpServerConfig, McpToolDescriptor } from '@/models/integrations/mcp'
import type { McpClientPort } from '@/services/ports/McpClientPort'
import { NButton, NIcon, NInput, NModal } from '@/ui'
import { useMessage } from '@/ui/services'

const message = useMessage()
const props = defineProps<{ client: McpClientPort }>()
const servers = ref<McpServerConfig[]>([])
const toolsByServer = ref<Record<string, McpToolDescriptor[]>>({})
const busyServerId = ref('')
const loading = ref(false)
const error = ref('')
const addDialogVisible = ref(false)
const addMode = ref<'local' | 'json'>('local')
const localName = ref('')
const localCommand = ref('npx')
const localArgs = ref('-y\n')
const localCwd = ref('')
const localEnv = ref('')
const jsonConfig = ref(`{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"]
    }
  }
}`)
const isNative = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const enabledCount = computed(() => servers.value.filter((server) => server.enabled).length)
const query = ref('')
const filter = ref<'all' | 'enabled' | 'trusted'>('all')
const selectedServerId = ref('')
const filterOptions = [
  { value: 'all' as const, label: '全部' },
  { value: 'enabled' as const, label: '已启用' },
  { value: 'trusted' as const, label: '已信任' },
]
const filteredServers = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  return servers.value.filter((server) => {
    if (filter.value === 'enabled' && !server.enabled) return false
    if (filter.value === 'trusted' && !server.trusted) return false
    return (
      !keyword || `${server.name} ${endpointLabel(server)}`.toLocaleLowerCase().includes(keyword)
    )
  })
})
const selectedServer = computed(
  () => servers.value.find((server) => server.id === selectedServerId.value) ?? null,
)
type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>

async function loadServers(): Promise<void> {
  if (!isNative) return
  loading.value = true
  error.value = ''
  try {
    servers.value = await props.client.listServers()
    if (!servers.value.some((server) => server.id === selectedServerId.value)) {
      selectedServerId.value = servers.value[0]?.id ?? ''
    }
  } catch (loadError) {
    error.value = errorMessage(loadError)
  } finally {
    loading.value = false
  }
}

async function chooseConfig(): Promise<void> {
  const selected = await open({
    title: '导入 MCP JSON 配置',
    multiple: false,
    directory: false,
    filters: [{ name: 'MCP JSON', extensions: ['json'] }],
  })
  if (typeof selected !== 'string' || !selected.trim()) return
  loading.value = true
  error.value = ''
  try {
    servers.value = await props.client.importConfig(selected)
    selectedServerId.value = servers.value[0]?.id ?? ''
    message.success(`已导入 MCP 配置，共 ${servers.value.length} 个服务`)
  } catch (importError) {
    error.value = errorMessage(importError)
  } finally {
    loading.value = false
  }
}

function openAddDialog(mode: 'local' | 'json' = 'local'): void {
  addMode.value = mode
  error.value = ''
  addDialogVisible.value = true
}

async function submitMcpConfig(): Promise<void> {
  if (!isNative) return
  let content = jsonConfig.value.trim()

  if (addMode.value === 'local') {
    const name = localName.value.trim()
    const command = localCommand.value.trim()
    if (!name || !command) {
      error.value = '本地 MCP 的名称和启动命令不能为空。'
      return
    }

    let env: Record<string, string> | undefined
    try {
      env = parseStringMap(localEnv.value, '环境变量')
    } catch (parseError) {
      error.value = errorMessage(parseError)
      return
    }

    content = JSON.stringify({
      mcpServers: {
        [name]: {
          command,
          args: localArgs.value
            .split(/\r?\n/)
            .map((argument) => argument.trim())
            .filter(Boolean),
          ...(localCwd.value.trim() ? { cwd: localCwd.value.trim() } : {}),
          ...(env ? { env } : {}),
        },
      },
    })
  }

  if (!content) {
    error.value = '请粘贴 MCP JSON 配置。'
    return
  }

  loading.value = true
  error.value = ''
  try {
    servers.value = await props.client.importConfigText(content)
    selectedServerId.value = servers.value[0]?.id ?? ''
    addDialogVisible.value = false
    message.success(`已添加 MCP 配置，共 ${servers.value.length} 个服务`)
  } catch (importError) {
    error.value = errorMessage(importError)
  } finally {
    loading.value = false
  }
}

function parseStringMap(source: string, label: string): Record<string, string> | undefined {
  if (!source.trim()) return undefined
  const parsed: unknown = JSON.parse(source)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label}必须是 JSON 对象。`)
  }
  const entries = Object.entries(parsed)
  if (entries.some(([, value]) => typeof value !== 'string')) {
    throw new Error(`${label}的值必须全部是字符串。`)
  }
  return Object.fromEntries(entries) as Record<string, string>
}

async function toggleServer(server: McpServerConfig, event: BrowserEvent): Promise<void> {
  const enabled = (event.target as BrowserInputElement).checked
  busyServerId.value = server.id
  error.value = ''
  try {
    const updated = await props.client.setServerEnabled(server.id, enabled)
    Object.assign(server, updated)
    message.success(enabled ? `已启用 ${server.name}` : `已停用 ${server.name}`)
  } catch (toggleError) {
    ;(event.target as BrowserInputElement).checked = server.enabled
    error.value = errorMessage(toggleError)
  } finally {
    busyServerId.value = ''
  }
}

async function toggleTrust(server: McpServerConfig): Promise<void> {
  const trusted = !server.trusted
  if (
    trusted &&
    !globalThis.confirm(
      `将“${server.name}”标记为可信？此后该服务的所有工具调用都会自动批准，包括可能产生写入或外部影响的工具。请只信任你能控制的服务。`,
    )
  ) {
    return
  }
  busyServerId.value = server.id
  error.value = ''
  try {
    const updated = await props.client.setServerTrusted(server.id, trusted)
    Object.assign(server, updated)
    message.success(trusted ? `已信任 ${server.name}` : `已取消信任 ${server.name}`)
  } catch (trustError) {
    error.value = errorMessage(trustError)
  } finally {
    busyServerId.value = ''
  }
}

async function inspectServer(server: McpServerConfig): Promise<void> {
  busyServerId.value = server.id
  error.value = ''
  try {
    const tools = await props.client.listTools(server.id)
    toolsByServer.value = { ...toolsByServer.value, [server.id]: tools }
    message.success(`连接成功，发现 ${tools.length} 个工具`)
  } catch (inspectError) {
    error.value = `${server.name}：${errorMessage(inspectError)}`
  } finally {
    busyServerId.value = ''
  }
}

async function removeServer(server: McpServerConfig): Promise<void> {
  if (!globalThis.confirm(`移除 MCP 服务“${server.name}”？`)) return
  busyServerId.value = server.id
  try {
    await props.client.removeServer(server.id)
    servers.value = servers.value.filter((item) => item.id !== server.id)
    if (selectedServerId.value === server.id) selectedServerId.value = servers.value[0]?.id ?? ''
    message.success('MCP 服务已移除')
  } catch (removeError) {
    error.value = errorMessage(removeError)
  } finally {
    busyServerId.value = ''
  }
}

function endpointLabel(server: McpServerConfig): string {
  if (server.transport === 'http') return server.url ?? '未配置 URL'
  return [server.command, ...server.args].filter(Boolean).join(' ')
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

defineExpose({
  enabledCount,
  serverCount: computed(() => servers.value.length),
  loading,
  chooseConfig,
})

onMounted(() => void loadServers())
</script>

<template>
  <section class="mcp-panel skill-library" aria-label="MCP 服务">
    <div class="skill-library__toolbar">
      <NInput v-model:value="query" size="small" clearable placeholder="搜索 MCP 服务">
        <template #prefix><Search :size="14" /></template>
      </NInput>
      <div class="skill-filter" aria-label="MCP 服务筛选">
        <button
          v-for="item in filterOptions"
          :key="item.value"
          type="button"
          :class="{ 'is-active': filter === item.value }"
          @click="filter = item.value"
        >
          {{ item.label }}
        </button>
      </div>
      <NButton quaternary circle aria-label="刷新 MCP 服务" :loading="loading" @click="loadServers">
        <template #icon
          ><NIcon :size="15"><RefreshCw /></NIcon
        ></template>
      </NButton>
      <NButton secondary :disabled="!isNative" @click="openAddDialog('local')">
        <template #icon
          ><NIcon :size="15"><Plus /></NIcon
        ></template>
        新建
      </NButton>
    </div>

    <p v-if="error" class="skill-error" role="alert"><TriangleAlert :size="15" />{{ error }}</p>

    <div class="skill-workbench mcp-workbench">
      <aside class="skill-list" aria-label="已配置 MCP 服务">
        <div class="skill-list__heading">
          <strong>MCP 服务</strong><span>{{ filteredServers.length }}</span>
        </div>
        <button
          v-for="server in filteredServers"
          :key="server.id"
          type="button"
          class="skill-list-item mcp-list-item"
          :class="{ 'is-active': selectedServerId === server.id }"
          @click="selectedServerId = server.id"
        >
          <span class="skill-list-item__icon"><Server :size="17" /></span>
          <span class="skill-list-item__body">
            <span
              ><strong>{{ server.name }}</strong
              ><small>{{ server.transport }}</small></span
            >
            <small>{{ endpointLabel(server) }}</small>
          </span>
          <label class="skill-switch" :title="server.enabled ? '停用' : '启用'" @click.stop>
            <input
              type="checkbox"
              :checked="server.enabled"
              :disabled="busyServerId === server.id"
              @change="toggleServer(server, $event)"
            />
            <span aria-hidden="true"></span>
          </label>
        </button>
        <div v-if="filteredServers.length === 0" class="skill-list__empty">
          <Cable :size="24" /><strong>没有 MCP 服务</strong><span>新建服务或导入 JSON 配置。</span>
        </div>
      </aside>

      <main v-if="selectedServer" class="skill-detail mcp-detail">
        <header class="skill-detail__header">
          <div>
            <span class="skill-detail__path">mcp/{{ selectedServer.id }}</span>
            <h2>{{ selectedServer.name }}</h2>
            <p>{{ endpointLabel(selectedServer) }}</p>
          </div>
          <NButton
            danger
            quaternary
            circle
            aria-label="移除 MCP 服务"
            @click="removeServer(selectedServer)"
          >
            <template #icon
              ><NIcon :size="15"><Trash2 /></NIcon
            ></template>
          </NButton>
        </header>
        <div class="mcp-detail__content">
          <div class="mcp-detail__status">
            <span><strong>连接方式</strong>{{ selectedServer.transport }}</span>
            <span><strong>启用状态</strong>{{ selectedServer.enabled ? '已启用' : '已停用' }}</span>
            <span
              ><strong>信任策略</strong
              >{{ selectedServer.trusted ? '自动批准工具调用' : '每次调用需确认' }}</span
            >
          </div>
          <div class="mcp-detail__actions">
            <NButton
              secondary
              :loading="busyServerId === selectedServer.id"
              @click="toggleTrust(selectedServer)"
            >
              <template #icon
                ><NIcon :size="14"><ShieldCheck /></NIcon
              ></template>
              {{ selectedServer.trusted ? '取消信任' : '标记为可信' }}
            </NButton>
            <NButton
              type="primary"
              :loading="busyServerId === selectedServer.id"
              @click="inspectServer(selectedServer)"
            >
              <template #icon
                ><NIcon :size="14"><CheckCircle2 /></NIcon
              ></template>
              测试并发现工具
            </NButton>
          </div>
          <section class="mcp-detail__tools">
            <header>
              <strong>可用工具</strong
              ><span>{{ toolsByServer[selectedServer.id]?.length ?? 0 }}</span>
            </header>
            <div v-if="toolsByServer[selectedServer.id]?.length" class="mcp-tool-list">
              <article v-for="tool in toolsByServer[selectedServer.id]" :key="tool.name">
                <strong>{{ tool.title || tool.name }}</strong>
                <p>{{ tool.description || '没有描述' }}</p>
                <small>{{ tool.serverTrusted ? '可信服务 · 自动批准' : '调用前确认' }}</small>
              </article>
            </div>
            <div v-else class="mcp-tools-empty">测试连接后将在这里显示服务提供的工具。</div>
          </section>
        </div>
      </main>
      <main v-else class="skill-detail skill-detail--empty">
        <FileJson :size="34" />
        <h2>选择或新建 MCP 服务</h2>
        <p>查看连接信息、信任策略与可用工具。</p>
      </main>
    </div>
  </section>

  <NModal v-model:show="addDialogVisible" title="添加 MCP 服务" class="mcp-add-modal">
    <div class="mcp-add-tabs" role="tablist" aria-label="MCP 添加方式">
      <button
        type="button"
        :class="{ 'mcp-add-tabs__item--active': addMode === 'local' }"
        class="mcp-add-tabs__item"
        @click="addMode = 'local'"
      >
        <Terminal :size="15" />本地 MCP
      </button>
      <button
        type="button"
        :class="{ 'mcp-add-tabs__item--active': addMode === 'json' }"
        class="mcp-add-tabs__item"
        @click="addMode = 'json'"
      >
        <ClipboardPaste :size="15" />粘贴 JSON
      </button>
    </div>

    <div v-if="addMode === 'local'" class="mcp-add-form">
      <p>配置通过 stdio 启动的本地 MCP。每行填写一个启动参数。</p>
      <label
        ><span>服务名称</span><NInput v-model:value="localName" placeholder="例如 filesystem"
      /></label>
      <label
        ><span>启动命令</span
        ><NInput v-model:value="localCommand" placeholder="例如 npx、node 或 uvx"
      /></label>
      <label>
        <span>启动参数（每行一个）</span>
        <textarea
          v-model="localArgs"
          rows="5"
          placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;D:\\Notes"
        ></textarea>
      </label>
      <label
        ><span>工作目录（可选）</span
        ><NInput v-model:value="localCwd" placeholder="例如 D:\\Projects"
      /></label>
      <label>
        <span>环境变量 JSON（可选）</span>
        <textarea v-model="localEnv" rows="3" placeholder='{ "API_KEY": "..." }'></textarea>
      </label>
    </div>

    <div v-else class="mcp-add-form">
      <p>支持 <code>mcpServers</code>、<code>servers</code>，以及直接以服务名为键的配置对象。</p>
      <label>
        <span>MCP JSON 配置</span>
        <textarea v-model="jsonConfig" class="mcp-add-form__json" rows="15"></textarea>
      </label>
    </div>

    <p v-if="error" class="skill-error" role="alert"><TriangleAlert :size="15" />{{ error }}</p>
    <template #footer>
      <NButton @click="addDialogVisible = false">取消</NButton>
      <NButton type="primary" :loading="loading" @click="submitMcpConfig">添加服务</NButton>
    </template>
  </NModal>
</template>
