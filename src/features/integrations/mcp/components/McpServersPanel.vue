<script setup lang="ts">
import { open } from '@tauri-apps/plugin-dialog'
import {
  Cable,
  CheckCircle2,
  ClipboardPaste,
  FileJson,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  TriangleAlert,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import type { McpServerConfig, McpToolDescriptor } from '@/models/mcp'
import {
  importMcpConfig,
  importMcpConfigText,
  listMcpServers,
  listMcpTools,
  removeMcpServer,
  setMcpServerEnabled,
  setMcpServerTrusted,
} from '@/services/McpService'
import { NButton, NIcon, NInput, NModal } from '@/ui'
import { useMessage } from '@/ui/services'

const message = useMessage()
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
    servers.value = await importMcpConfigText(content)
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
      `将“${server.name}”标记为可信？此后该服务的所有工具调用都会自动批准，包括可能产生写入或外部影响的工具。请只信任你能控制的服务。`,
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
        <NButton secondary :disabled="!isNative" :loading="loading" @click="chooseConfig">
          <template #icon
            ><NIcon :size="15"><FileJson /></NIcon
          ></template>
          导入文件
        </NButton>
        <NButton type="primary" :disabled="!isNative" :loading="loading" @click="openAddDialog()">
          <template #icon
            ><NIcon :size="15"><Plus /></NIcon
          ></template>
          添加 MCP
        </NButton>
      </div>
    </header>

    <p class="mcp-panel__notice">
      导入本地 stdio
      服务会允许应用启动配置中的外部命令。服务默认为不可信；标记为可信后，该服务的所有工具调用都会自动批准。未信任服务可按单次调用或当前任务授权。
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
              {{ tool.serverTrusted ? '可信 · 自动批准' : '需确认' }}
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
            <template #icon
              ><NIcon :size="14"><ShieldCheck /></NIcon
            ></template>
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
      <strong>尚未添加 MCP 服务</strong>
      <span>可以填写本地启动命令、直接粘贴 JSON，或从 JSON 文件导入。</span>
      <div class="mcp-panel__empty-actions">
        <NButton type="primary" :disabled="!isNative" @click="openAddDialog('local')">
          <template #icon
            ><NIcon :size="15"><Terminal /></NIcon></template
          >添加本地 MCP
        </NButton>
        <NButton secondary :disabled="!isNative" @click="openAddDialog('json')">
          <template #icon
            ><NIcon :size="15"><ClipboardPaste /></NIcon></template
          >粘贴 JSON
        </NButton>
      </div>
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
    <div class="mcp-add-modal__actions">
      <NButton @click="addDialogVisible = false">取消</NButton>
      <NButton type="primary" :loading="loading" @click="submitMcpConfig">添加服务</NButton>
    </div>
  </NModal>
</template>
