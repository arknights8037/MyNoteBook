<script setup lang="ts">
import { AlertTriangle, CheckCircle2, Eye, RefreshCw, ShieldAlert } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import type { McpServerExposureSettings } from '@/models/integrations/mcp'
import type { McpClientPort } from '@/services/ports/McpClientPort'
import { NButton, NIcon } from '@/ui'
import { useMessage } from '@/ui/services'

type RiskLevel = 'read' | 'sensitive' | 'write'

interface ExposureTool {
  name: string
  category: string
  purpose: string
  disabledImpact: string
  enabledRisk: string
  risk: RiskLevel
  requiresToken: boolean
}

type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>

const tools: ExposureTool[] = [
  {
    name: 'search_knowledge',
    category: '只读检索',
    purpose: '按关键词搜索当前资料库中的文档正文与命中片段。',
    disabledImpact: '外部 Agent 无法检索知识库，只能依赖调用方已有上下文。',
    enabledRisk: '查询词可能命中私人笔记、内部规则或未公开资料片段。',
    risk: 'read',
    requiresToken: false,
  },
  {
    name: 'list_agent_projects',
    category: '项目读取',
    purpose: '读取 Agent 项目、资料根目录、既有对话和可用 A2A 分支。',
    disabledImpact: '外部 Agent 无法发现任务应归属的项目和分支。',
    enabledRisk: '项目名称、资料分组和对话标题会暴露给持有能力令牌的客户端。',
    risk: 'sensitive',
    requiresToken: true,
  },
  {
    name: 'create_agent_branch',
    category: '分支创建',
    purpose: '在指定项目下创建稳定的 A2A 对话分支，可关联父对话。',
    disabledImpact: '外部 Agent 只能提交散落任务，无法按项目维护连续协作上下文。',
    enabledRisk: '持有能力令牌的客户端可在本地项目目录中登记新的协作分支。',
    risk: 'write',
    requiresToken: true,
  },
  {
    name: 'submit_agent_request',
    category: '任务创建',
    purpose: '向应用内 Agent Runtime 提交一个独立的通用任务。',
    disabledImpact: '外部 Agent 不能发起 A2A 通用任务。',
    enabledRisk: '持有能力令牌的客户端可消耗模型额度，并生成等待审阅的修改提案。',
    risk: 'write',
    requiresToken: true,
  },
  {
    name: 'submit_cognitive_request',
    category: '研究学习',
    purpose: '提交研究、审阅或学习任务，并在应用内形成独立结果。',
    disabledImpact: '外部 Agent 不能远程启动研究、审阅和学习流程。',
    enabledRisk: '持有能力令牌的客户端可持续消耗模型额度，并产生新的研究资料或候选知识。',
    risk: 'write',
    requiresToken: true,
  },
  {
    name: 'get_agent_request',
    category: '结果读取',
    purpose: '读取任务状态、Agent 结果以及待审阅的 Patch 内容。',
    disabledImpact: '外部 Agent 无法轮询任务进度，也无法检查结果后继续审批或修订。',
    enabledRisk: '请求原文、执行结果与文档修改内容可能被外部客户端读取。',
    risk: 'sensitive',
    requiresToken: false,
  },
  {
    name: 'decide_agent_request',
    category: '审批写入',
    purpose: '批准或拒绝一个已经进入待审阅状态的 Agent 修改提案。',
    disabledImpact: '外部 Agent 不能完成审批，提案需要回到桌面应用处理。',
    enabledRisk: '持有能力令牌的客户端可批准 Patch，最终导致笔记内容发生实际修改。',
    risk: 'write',
    requiresToken: true,
  },
  {
    name: 'revise_agent_request',
    category: '提案修订',
    purpose: '携带反馈重新排队当前待审阅提案，保留原任务关联。',
    disabledImpact: '外部 Agent 无法要求定向修订，只能重新提交完整任务。',
    enabledRisk: '持有能力令牌的客户端可反复触发模型调用、替换待审阅提案并增加费用。',
    risk: 'write',
    requiresToken: true,
  },
]

const message = useMessage()
const props = defineProps<{ client: McpClientPort }>()
const isNative = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const settings = ref<McpServerExposureSettings>({
  version: 1,
  tools: Object.fromEntries(tools.map((tool) => [tool.name, true])),
})
const loading = ref(false)
const changingTool = ref('')
const error = ref('')
const enabledCount = computed(() => tools.filter((tool) => isEnabled(tool.name)).length)

function isEnabled(toolName: string): boolean {
  return settings.value.tools[toolName] !== false
}

async function loadSettings(): Promise<void> {
  if (!isNative) return
  loading.value = true
  error.value = ''
  try {
    settings.value = await props.client.getServerExposure()
  } catch (loadError) {
    error.value = errorMessage(loadError)
  } finally {
    loading.value = false
  }
}

async function toggleTool(tool: ExposureTool, event: BrowserEvent): Promise<void> {
  const enabled = (event.target as BrowserInputElement).checked
  const previous = isEnabled(tool.name)
  settings.value.tools[tool.name] = enabled
  changingTool.value = tool.name
  error.value = ''
  try {
    settings.value = await props.client.setServerToolExposure(tool.name, enabled)
    message.success(`${tool.name} 已${enabled ? '暴露' : '关闭'}，将在下次 MCP Server 连接时生效`)
  } catch (toggleError) {
    settings.value.tools[tool.name] = previous
    error.value = errorMessage(toggleError)
  } finally {
    changingTool.value = ''
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

defineExpose({ enabledCount, toolCount: tools.length, loading, loadSettings })
onMounted(() => void loadSettings())
</script>

<template>
  <section class="mcp-exposure" aria-label="MCP Server 工具暴露设置">
    <header class="mcp-exposure__header">
      <div>
        <span class="mcp-exposure__kicker"><ShieldAlert :size="15" /> OUTBOUND TOOL SURFACE</span>
        <h2>MCP Server 工具暴露面</h2>
        <p>关闭的工具不会出现在 <code>tools/list</code> 中，按名称直接调用也会被拒绝。</p>
      </div>
      <div class="mcp-exposure__header-actions">
        <strong>{{ enabledCount }} / {{ tools.length }}</strong>
        <span>当前对外暴露</span>
        <NButton
          quaternary
          circle
          aria-label="刷新暴露设置"
          :loading="loading"
          @click="loadSettings"
        >
          <template #icon
            ><NIcon :size="15"><RefreshCw /></NIcon
          ></template>
        </NButton>
      </div>
    </header>

    <aside class="mcp-exposure__notice">
      <AlertTriangle :size="17" />
      <p>
        设置在新的 MCP Server
        进程或客户端重连后生效。能力令牌只负责鉴权，不能替代最小暴露原则；标有“需要令牌”的工具仍应仅向可信客户端开放。
      </p>
    </aside>

    <p v-if="error" class="skill-error" role="alert"><AlertTriangle :size="15" />{{ error }}</p>

    <div class="mcp-exposure__table" role="table" aria-label="对外工具列表">
      <div class="mcp-exposure__table-head" role="row">
        <span>工具与作用</span><span>关闭后的缺失</span><span>开启后的风险</span><span>暴露</span>
      </div>
      <article
        v-for="tool in tools"
        :key="tool.name"
        class="mcp-exposure__tool"
        :class="`risk-${tool.risk}`"
        role="row"
      >
        <div class="mcp-exposure__identity" role="cell">
          <div>
            <code>{{ tool.name }}</code
            ><span>{{ tool.category }}</span>
          </div>
          <p>{{ tool.purpose }}</p>
          <small v-if="tool.requiresToken"><CheckCircle2 :size="12" /> 需要能力令牌</small>
          <small v-else><Eye :size="12" /> 无需能力令牌</small>
        </div>
        <p role="cell">{{ tool.disabledImpact }}</p>
        <p role="cell" class="mcp-exposure__risk">
          <AlertTriangle :size="14" />{{ tool.enabledRisk }}
        </p>
        <div class="mcp-exposure__toggle" role="cell">
          <label class="skill-switch" :title="isEnabled(tool.name) ? '关闭暴露' : '开启暴露'">
            <input
              type="checkbox"
              :checked="isEnabled(tool.name)"
              :disabled="!isNative || changingTool === tool.name"
              :aria-label="`${isEnabled(tool.name) ? '关闭' : '开启'} ${tool.name}`"
              @change="toggleTool(tool, $event)"
            />
            <span></span>
          </label>
          <small>{{ isEnabled(tool.name) ? '已暴露' : '已关闭' }}</small>
        </div>
      </article>
    </div>
  </section>
</template>
