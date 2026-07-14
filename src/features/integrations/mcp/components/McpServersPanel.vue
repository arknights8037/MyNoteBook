<script setup lang="ts">
import { open } from '@tauri-apps/plugin-dialog'
import {
  Cable,
  CheckCircle2,
  FileJson,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import type { McpServerConfig, McpToolDescriptor } from '@/models/mcp'
import {
  importMcpConfig,
  listMcpServers,
  listMcpTools,
  removeMcpServer,
  setMcpServerEnabled,
  setMcpServerTrusted,
} from '@/services/McpService'
import { NButton, NIcon } from '@/ui'
import { useMessage } from '@/ui/services'

const message = useMessage()
const servers = ref<McpServerConfig[]>([])
const toolsByServer = ref<Record<string, McpToolDescriptor[]>>({})
const busyServerId = ref('')
const loading = ref(false)
const error = ref('')
const isNative = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const enabledCount = computed(() => servers.value.filter((server) => server.enabled).length)
type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>

async function loadServers(): Promise<void> {
  if (!isNative) return
  loading.value = true
  error.value = ''
  try {
    servers.value = await listMcpServers()
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
    servers.value = await importMcpConfig(selected)
    message.success(`已导入 MCP 配置，共 ${servers.value.length} 个服务`)
  } catch (importError) {
    error.value = errorMessage(importError)
  } finally {
    loading.value = false
  }
}

async function toggleServer(server: McpServerConfig, event: BrowserEvent): Promise<void> {
  const enabled = (event.target as BrowserInputElement).checked
  busyServerId.value = server.id
  error.value = ''
  try {
    const updated = await setMcpServerEnabled(server.id, enabled)
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
      `将“${server.name}”标记为本地可信？该服务声明为只读的工具之后可免逐次确认。`,
    )
  ) {
    return
  }
  busyServerId.value = server.id
  error.value = ''
  try {
    const updated = await setMcpServerTrusted(server.id, trusted)
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
    const tools = await listMcpTools(server.id)
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
    await removeMcpServer(server.id)
    servers.value = servers.value.filter((item) => item.id !== server.id)
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

onMounted(() => void loadServers())
</script>

<template>
  <section class="mcp-panel" aria-label="MCP 服务">
    <header class="mcp-panel__header">
      <div>
        <span class="plugin-skills-page__eyebrow"><Cable :size="14" /> MCP CLIENT</span>
        <h2>外部 MCP 服务</h2>
        <p>导入标准 JSON 配置，连接 stdio 或 Streamable HTTP 服务，并将已启用工具提供给 Agent。</p>
      </div>
      <div class="mcp-panel__actions">
        <span
          ><strong>{{ enabledCount }}</strong> / {{ servers.length }} 已启用</span
        >
        <NButton
          quaternary
          circle
          aria-label="刷新 MCP 服务"
          :loading="loading"
          @click="loadServers"
        >
          <template #icon
            ><NIcon :size="15"><RefreshCw /></NIcon
          ></template>
        </NButton>
        <NButton type="primary" :disabled="!isNative" :loading="loading" @click="chooseConfig">
          <template #icon
            ><NIcon :size="15"><FileJson /></NIcon
          ></template>
          导入 JSON
        </NButton>
      </div>
    </header>

    <p class="mcp-panel__notice">
      导入本地 stdio 服务会允许应用启动配置中的外部命令。服务默认为不可信；只有本地明确标记为可信，且工具声明只读时，才免除逐次确认。
    </p>
    <p v-if="error" class="skill-error" role="alert"><TriangleAlert :size="15" />{{ error }}</p>

    <div v-if="servers.length" class="mcp-server-list">
      <article v-for="server in servers" :key="server.id" class="mcp-server-card">
        <div class="mcp-server-card__icon"><Server :size="18" /></div>
        <div class="mcp-server-card__body">
          <div class="mcp-server-card__title">
            <strong>{{ server.name }}</strong>
            <span>{{ server.transport }}</span>
            <span v-if="toolsByServer[server.id]" class="status-success">
              <CheckCircle2 :size="12" />{{ toolsByServer[server.id]?.length }} tools
            </span>
          </div>
          <code>{{ endpointLabel(server) }}</code>
          <div v-if="toolsByServer[server.id]?.length" class="mcp-tool-chips">
            <span
              v-for="tool in toolsByServer[server.id]"
              :key="tool.name"
              :title="tool.description"
            >
              {{ tool.title || tool.name }} ·
              {{ tool.readOnly && tool.serverTrusted ? '可信只读' : '需确认' }}
            </span>
          </div>
        </div>
        <div class="mcp-server-card__actions">
          <NButton
            size="small"
            :type="server.trusted ? 'primary' : 'default'"
            secondary
            :loading="busyServerId === server.id"
            @click="toggleTrust(server)"
          >
            <template #icon><NIcon :size="14"><ShieldCheck /></NIcon></template>
            {{ server.trusted ? '已信任' : '不可信' }}
          </NButton>
          <NButton
            size="small"
            secondary
            :loading="busyServerId === server.id"
            @click="inspectServer(server)"
          >
            测试并发现工具
          </NButton>
          <label class="skill-switch" :title="server.enabled ? '停用' : '启用'">
            <input
              type="checkbox"
              :checked="server.enabled"
              :disabled="busyServerId === server.id"
              @change="toggleServer(server, $event)"
            />
            <span aria-hidden="true"></span>
          </label>
          <NButton quaternary circle aria-label="移除 MCP 服务" @click="removeServer(server)">
            <template #icon
              ><NIcon :size="15"><Trash2 /></NIcon
            ></template>
          </NButton>
        </div>
      </article>
    </div>
    <div v-else class="mcp-panel__empty">
      <FileJson :size="25" />
      <strong>尚未导入 MCP 服务</strong>
      <span>支持包含 <code>mcpServers</code> 的 JSON，以及直接以服务名为键的配置对象。</span>
      <pre>
{
  "mcpServers": {
    "example": { "command": "npx", "args": ["-y", "@example/mcp-server"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}</pre
      >
    </div>
  </section>
</template>
