# PI 接入资料：第二批（高价值补充）

> 代码核对日期：2026-07-29；与《PI 接入资料：第一批（必须信息）》配套使用。
>
> 本文把“当前事实”“已知问题”和“PI 接入前需要决策的事项”分开，作为评审输入保留。权威架构方向、阶段依赖和退出条件见 [后续开发路线图](roadmap.md)。

## 1. 当前架构与所有权

```text
Vue/WebView
  ├─ UI、Ask/Edit/Agent/Auto 分发
  ├─ Agent Runtime（AI SDK ToolLoopAgent）
  ├─ Context/Skill/MCP tool 编译
  ├─ Tool lifecycle、流式展示、授权等待
  ├─ TS repositories ───────────────┐
  │                                 │ plugin-sql direct SQL
  └─ Tauri invoke / Channel         ▼
                              SQLite editor.db
Tauri/Rust                          ▲
  ├─ migration、WAL、backup         │ SQLx
  ├─ canonical document transaction ┘
  ├─ 原生 tools / MCP / Skills / files
  ├─ secret store
  └─ model HTTP stream proxy

独立 Rust binaries
  ├─ mynotebook-mcp    # 本地 stdio MCP Server
  └─ mynotebook-agent  # MCP CLI Client
```

代码依赖方向总体为 `models -> repositories/ports -> services -> infrastructure/composition -> UI`，但 `useAgentRun.ts` 同时承担应用编排、运行状态和多领域接线，已经成为高耦合入口。

## 2. 当前 Agent 数据结构

### 2.1 Task、Run、Session

核心 `AgentTask`：

```ts
interface AgentTask {
  id: string
  sessionId: string
  projectId: string
  conversationId: string
  status: 'pending' | 'running' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled'
  userInstruction: string
  contextScope: 'selection' | 'current_block' | 'current_document'
  model: string
  currentStep: string
  createdAt: number
  completedAt: number | null
  error: string | null
  correlationId: string
  causationId: string | null
  executionPolicy: ExecutionPolicy
  contextBundleId: string | null
  provider: AiProvider
  taskRunId: string | null
}
```

ID 现状：

- `AgentTask.id` 是最稳定的 Agent 执行/审计 ID，并关联 tool calls、Patch、context bundle 和 transaction。
- migration trigger 另建 `task_runs.id = "taskrun-agent-" + AgentTask.id`，用于通用 Work 模型。
- `useAgentRun` 还创建一个 UI lifecycle `runId`，保存在 runtime view/lifecycle 中，但不是所有表的统一主键。
- 因此系统有 task id、task-run id、runtime run id 三套相关 ID，没有单一全局 `run_id` 契约。
- `sessionId` 实际被 `createAgentEditPlan()` 赋值为当前 `document.id`，repository 又同时写入 `agent_tasks.session_id` 和 `document_id`。它不是独立 Session ID，字段名存在历史语义负担。
- `CognitiveSession.id` 才是 Research/Review/Learning 的稳定 session，使用 `conversation_id` 关联，并支持 Learning `waiting_user` 恢复。

### 2.2 Conversation 与 Message

领域消息不是 OpenAI message 结构：

```ts
interface AiChatHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  mode: 'ask' | 'edit' | 'agent' | 'auto'
  content: string
  reasoningContent?: string
  researchResult?: ResearchResult
  reviewResult?: ReviewResult
  learningResult?: LearningTurnResult
  learningState?: LearningSessionState
  cognitiveProvenance?: CognitiveResultProvenance
  agentRuntime?: AgentRuntimeViewState
  status: 'streaming' | 'done' | 'error'
}
```

特点：

- 只保存 `user/assistant`，不会把 provider 的 `tool` message 直接写入业务消息历史。
- Tool Call/Result 独立保存在 runtime trace 和 `agent_tool_calls`，而不是混进 Conversation messages。
- 整个 workspace/project/conversation/message 集合作为 version 3 JSON 写入唯一的 `agent_workspace_state(id='current')`；最多保留 100 条 history item。
- 终态 runtime history 最多保留 64 tool calls、128 timeline events 和 256 run events。
- Provider、model 存在 history item 层，不绑定 OpenAI message schema。

### 2.3 ToolCall 与 ToolResult

```ts
interface AgentToolRequest {
  callId?: string
  name: string
  arguments: Record<string, unknown>
  signal?: AbortSignal
}

interface AgentToolExecutionResult {
  ok: boolean
  value?: unknown
  error?: string
  errorCode?: string
  retryable?: boolean
  retryAfterMs?: number
}
```

- Runtime 在 tool `execute()` 开始时自行生成 `callId`，用它关联 running/completed audit、进度、Rust/MCP 调用和取消。
- 当前 AI SDK tool callback 只接收解析后的 args；代码没有保存 Provider 原始 tool-call ID。PI 若要求保留模型 tool-call ID，需要新增映射字段，而不是复用现有 runtime ID 后假装相同。
- MCP 返回值目前作为 opaque JSON value 进入统一 result；built-in Rust tool 返回 JSON string 后由 TS `JSON.parse()`。

### 2.4 Runtime State、Context、Memory

`AgentRuntimeViewState` 包含 status/phase/detail/rounds/toolCalls/timelineEvents/authorizationRequest/summary/lifecycle/runEvents；它偏 UI projection，不是可恢复执行状态机快照。

`ExecutionPolicy`：

```ts
interface ExecutionPolicy {
  version: 1
  maxToolRounds: number
  maxDurationMs: number
  maxToolFailures: number
  tokenBudget: number
  allowedTools: string[]
  riskLevel: 'read_only' | 'propose_write' | 'sensitive'
  allowUserInput: boolean
  allowWriteProposals: boolean
  maxRetries: number
}
```

`ContextBundle v2` 保存 scope、permission snapshot、source content snapshot/hash、active rules、decisions、conflicts、compiler metadata、correlation/causation、provider 参数和 Skill versions。它是可审计的模型输入快照，但不是自动压缩/回忆式 Memory。

当前“Memory”由三部分拼成：

1. conversation messages 快照；
2. approved/active Knowledge Objects；
3. immutable Context Bundle provenance。

没有单独 `Memory` interface、向量库或自动 episodic memory。FTS5 用于文档全文搜索。

### 2.5 结构化输出与轨迹保存

- 普通 Agent 终态使用本地 Zod `agentOutputSchema`，可得到 proposal/no_change/blocked。
- Research/Review/Learning 可注入版本化 `AgentOutputContract<T>`，AI SDK structured output 失败时最多做受限 repair，再本地 validate。
- Edit 模式仍使用手写 `agent-json` 协议并由本地 normalizer 兼容解析。
- 系统保存最终消息、reasoning 展示内容、context bundle、tool args/result/error、rounds、finish reason、usage 和 Patch/transaction。
- 不保存完整 Provider 原始 request/response、每轮完整 SDK messages、Provider tool-call IDs 或可从任意中间 step 重放的 checkpoint。因此它不是完整模型轨迹仓库。

## 3. 模型 Provider 层

### 3.1 当前支持

```ts
type AiProvider = 'openai' | 'anthropic' | 'deepseek' | 'qwen' | 'openai-compatible'
```

默认 endpoint：

| Provider          | Endpoint/协议                                                          |
| ----------------- | ---------------------------------------------------------------------- |
| OpenAI            | `https://api.openai.com/v1`，OpenAI-compatible SDK/Chat Completions    |
| Anthropic         | `https://api.anthropic.com/v1`，Anthropic SDK/Messages                 |
| DeepSeek          | `https://api.deepseek.com`，OpenAI-compatible                          |
| Qwen              | `https://dashscope.aliyuncs.com/compatible-mode/v1`，OpenAI-compatible |
| OpenAI-compatible | 用户自定义 base URL                                                    |

API Key 不写入 AI settings localStorage。非密钥 profile 写 localStorage；密钥由 Rust `secret_store` 使用 AES-256-GCM 和系统 credential store 保护，运行期间可缓存在内存。

### 3.2 当前“接口”与实现

目前没有正式 `ModelProvider` port/interface。Agent 路径只有一个 factory：

```ts
export function createAiSdkModel(settings: AiSettings): LanguageModel {
  const baseURL = settings.endpoint.replace(/\/+$/, '')
  if (settings.provider === 'anthropic') {
    return createAnthropic({
      apiKey: settings.apiKey,
      baseURL,
      name: 'mynotebook-anthropic',
      fetch: proxyAiFetch,
    })(settings.model)
  }
  return createOpenAICompatible({
    name: `mynotebook-${settings.provider}`,
    apiKey: settings.apiKey,
    baseURL,
    includeUsage: true,
    fetch: proxyAiFetch,
  })(settings.model)
}
```

`proxyAiFetch` 把标准 `fetch` 输入变成 Tauri `proxy_ai_request`，Rust `reqwest` 收到流后通过 Channel 发回 header/chunk/finished。

另有一条独立路径：`runAiMarkdownCompletion()` 手工拼 OpenAI Chat Completions 或 Anthropic Messages body、解析 SSE，并用于 Ask/Edit。这意味着：

- Agent 模式与 Ask/Edit 的 sampling、reasoning、stream/error 处理不是同一 Provider abstraction；
- 新增 Provider 至少要检查 `ai.ts`、capabilities、AI SDK factory、手写 HTTP path、model list 与 UI；
- 当前 `AgentRuntime` 不能仅替换一个通用 `streamFn`，因为它直接创建 AI SDK model 和 `ToolLoopAgent`。

### 3.3 对 PI 的三种接法（只列事实约束）

| 接法                                  | 可复用                                                 | 主要缺口                                                                                                |
| ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 保留现有 Provider，PI 只接 Agent core | `AiSettings`、secret store、Rust proxy、现有模型兼容性 | 需要抽出稳定 `streamFn`/model port，并统一 tool call/event 格式                                         |
| 切到 `pi-ai` + `pi-agent-core`        | 可删减 AI SDK Agent/手写双路径                         | 需验证 Anthropic/OpenAI-compatible/Qwen reasoning、Tauri proxy fetch、structured output 和 usage 一致性 |
| 先做 PI Tool Adapter，Provider 暂不迁 | Domain executors、policy、audit、Patch 安全边界可保留  | 两个 adapter 可为原型同时存在于代码库，但同一 `run_id` 只能选一个；决策门前生产流量仍只走 AI SDK        |

在做选择前应先用一个只读工具、一个 MCP 工具、一个 Patch proposal 和一次取消做纵向 prototype；不要先迁全部工具。

## 4. MCP 实现

### 4.1 配置格式与存储

配置存储在用户数据目录 `mcp-servers.json`，不是 SQLite：

```ts
interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  trusted: boolean
  command?: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  url?: string
  headers: Record<string, string>
}
```

支持导入常见 `{mcpServers:{...}}` / `{servers:{...}}` JSON。导入不会自动 trusted。需要注意：手动导入的 `env`/`headers` 当前会以明文 JSON 保存；Agent 创建 MCP 草稿则不允许传 env/header，且强制 disabled/untrusted。向外提供资料前不要附真实用户的 `mcp-servers.json`。

### 4.2 Client 初始化与调用

Rust `mcp.rs` 使用 `rmcp`：

- stdio：`TokioChildProcess(Command)`；
- HTTP：`StreamableHttpClientTransport<reqwest::Client>`；
- discovery/call/resource 默认 30 秒 timeout，close 2 秒；
- 每次 list/call/read 都建立 client，完成后关闭；当前没有长连接池或常驻 stdio server session；
- `call_mcp_tool` 可用 `call_id` 注册 cancellation guard，并以 `tokio::select!` 取消 future。

### 4.3 MCP Tool 到内部 Tool

```text
Rust tools/list
  -> McpToolDescriptor
       serverId/serverName/name/description/inputSchema
       readOnly/serverTrusted
  -> createMcpRuntimeTools()
       runtimeName = mcp__<safe-server-id>__<safe-tool-name>
       requiresConfirmation = !serverTrusted
       tags = external.read | external.may_write
  -> buildAgentToolSet()
       jsonSchema(inputSchema)
  -> createExecuteToolCallback()
       当前 server trusted 可直接调用
       server untrusted 时 request_authorizer_input
  -> TauriMcpClient.callTool()
  -> Rust rmcp call_tool
```

**当前代码事实**：`createMcpRuntimeTools()` 设置 `requiresConfirmation = !serverTrusted`；`readOnlyHint` 只决定 `external.read` / `external.may_write` tag 和只读重试，不参与普通 Agent 的调用前确认。因此 trusted server 暴露的非只读工具当前也会免逐次确认。项目现有说明写的是“trusted + readOnly 才免确认”，两者不一致。一次任务也可选择“允许本次任务”缓存 untrusted server 的后续授权。

这应在 PI Adapter 前先修正并加契约测试：目标安全策略应显式写成 `requiresConfirmation = !(serverTrusted && readOnly)`，并确保 Cognitive tag 过滤不能替代调用时授权。

### 4.4 MCP 保留建议所需的 Adapter 点

PI 不应直接替换 Rust MCP client。较低成本的边界是：

```text
MCP Descriptor
  -> Domain ExternalTool（保留 trust/risk/call cap）
  -> PiToolAdapter（只适配 schema/call/result/event）
  -> McpClientPort（保留 Tauri RPC）
```

必须额外验证 PI 对 MCP `isError` content、binary/resource content、取消和并行 call 的表达方式，避免把 MCP 业务错误误包成成功的 opaque value。

## 5. Skill 实现

### 5.1 目录与状态

```text
<data-directory>/skills/
├─ .skill-state.json              # disabled skill ID 集合
└─ <skill-id>/
   ├─ SKILL.md                    # 必须；YAML frontmatter name/description，可选 version
   ├─ references/                 # 可选文本参考
   ├─ scripts/                    # 可选；当前只是文件，不自动执行
   └─ assets/                     # 可选
```

Rust `skills.rs` 负责 import/create/list/read/write/remove、frontmatter 检查、文本大小限制、路径逃逸防护和 symlink 处理。Skill 可以运行时导入、编辑、启停，因此属于动态 Skill。

### 5.2 Prompt 与工具行为

`loadEnabledSkillPrompt()` 只加载启用且有效 Skill 的：

```text
- <skill-id>: <description>（入口：SKILL.md；可按需读取其下属文件）
```

完整 `SKILL.md` 不会预注入。Agent 匹配到某项能力后调用只读 `read_skill_file(skillId, 'SKILL.md')`，再按需读取 references/scripts/assets 中的文本。Rust 会再次确认 skill 已启用、有效且相对路径没有逃逸。

Skill 当前：

- 可以修改 prompt/workflow 行为；
- 可以被 Context Bundle 记录版本 provenance；
- 不会直接注册新 executable tool；
- 不能扩展 `ExecutionPolicy.allowedTools`；
- scripts 目录不会被自动执行；若工作流需要能力，只能调用 Runtime 已暴露的内置/MCP tools。

因此平滑映射是 `Skill -> Runtime Configuration / Context Hook`，而不是把 Skill 当作 Tool plugin。

## 6. 具体问题（按严重程度）

### P0：按既定方向收敛 SQLite 单一所有者

当前 TS plugin-sql 与 Rust SQLx 都访问 `editor.db`。Rust 掌握 migration、canonical document projection 和关键 transaction；TS 直接完成大量 repository CRUD。Node/PI 若直接写库会引入第三个 writer、第三套 connection pool、第三套 schema model 和关闭/迁移协调。

方向已经确定：Rust Core 逐步成为 SQLite、连接器、凭据、Workflow 状态和副作用的唯一所有者。PI prototype 与未来 Node Worker 只通过 Runtime/Tool RPC 调用 Rust 领域能力，禁止直接连接 SQLite；存量 WebView `plugin-sql` 写路径按路线图迁移，不能新增第三个 writer。

### P1：运行时只能依附前端，不能可靠后台执行/恢复

`useAgentRun`、授权等待、A2A polling 都在 Vue/WebView；A2A worker 用 1 秒 `setInterval`。关闭应用会停止模型与工作流。恢复逻辑只把 pending/running 标成 interrupted/failed，不能从 tool step checkpoint 继续。自动化目前也只有定义和 queue，没有执行 worker。

这会直接阻塞“收到邮件后异步分类/提取/等待确认”等目标，而不只是 UI 体验问题。

### P1：Tool contract 与错误语义未单源化

同一工具可能同时存在：Registry definition、AI SDK Zod schema、TS argument parser、Rust Rig JSON Schema/Rust Args、MCP descriptor、UI presentation。`requiresConfirmation` 还混合“调用前授权”和“写后 Patch 审批”两类语义。MCP 已出现具体偏差：实现只检查 `serverTrusted`，目标安全不变量则要求 `serverTrusted && readOnly`。

PI Adapter 若直接建立在其中任意一层，会保留漂移。应先形成可生成 provider schema 的 Domain Tool manifest，executor 和 UI metadata 引用同一稳定 ID/version。

### P1：Provider 层有两条流式路径且 Runtime 直接依赖 AI SDK

Ask/Edit 手写 HTTP，Agent 使用 AI SDK。Provider capability、reasoning 参数、max token、usage、abort 和 error mapping 分散。迁 PI 时如果只替换 Agent path，行为会继续分叉；如果一次替换全部，又扩大验证范围。

### P2：持久化不足以支持完整可恢复 Run

对话是单行 JSON aggregate，runtime trace 有截断；审计表又保存另一部分事实。没有 normalized run-step/model-turn/checkpoint 表，也没有 Provider tool-call ID。`tokenBudget` 只是 max output token 的配置上限，没有累计 usage 扣减器。长任务暂停、重启恢复、成本预算和完整 replay 都需要补协议。

## 7. 目标平台与发布要求

### 7.1 当前事实

| 问题                        | 当前答案                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只支持 Windows？            | 当前实际优先 Windows：WebView2 target、DWM acrylic、Windows Registry 字体、PowerShell shell tool、路线图中的 Windows 安装升级验收。代码有部分非 Windows fallback，bundle 也声明 all，但 macOS/Linux 未形成已验收发布承诺。 |
| 用户是否需要 Node           | 已安装桌面应用本体当前不要求 Node；开发构建要求 Node >=22.12。用户配置的 stdio MCP 可能自行依赖系统 Node。PI/Node sidecar 尚未打包。                                                                                       |
| UI 关闭后后台继续           | 不支持。Tauri 进程和 WebView runtime 一起结束；无 daemon/worker 接管。                                                                                                                                                     |
| 托盘常驻                    | 未实现。                                                                                                                                                                                                                   |
| 开机启动                    | 未实现。                                                                                                                                                                                                                   |
| 数据必须完全本地            | 文档、DB、附件、Skill 和主要审计本地；但云模型会收到本轮选择的 prompt/context，IMAP/RSS/钉钉/MCP 也会联网。只有选择本地 OpenAI-compatible endpoint 才可能让模型数据不出机。                                                |
| IM Webhook 云 Relay         | 当前没有自建云 Relay。钉钉是应用直连官方 Stream WebSocket；邮件直连 IMAP；RSS 直连源站。未来是否允许 Relay 尚未决策。                                                                                                      |
| 插件/动态 Skill             | 动态 Skill 和动态 MCP server/tool 已支持；Vue Widget/plugin 第一阶段仍是随应用编译注册，不执行任意用户 JS/Vue/HTML/SQL。                                                                                                   |
| 移动端/Web client 连接 Core | 当前没有远程 Core API、鉴权、多客户端同步或 headless service。`cfg_attr(mobile)` 和跨平台 icon 不代表产品支持。                                                                                                            |

### 7.2 PI/Node 发布前必须验证的要求

1. Windows 安装包中的 Worker 必须自包含，不能依赖用户安装 Node 或配置 PATH；具体打包形式需由原型和安装升级验收确定。
2. 进程形态按阶段推进：先由 Rust 通过 stdio 启动和监督 Worker，再完成托盘后台与 lease，稳定后才评估独立 daemon；不得在 PI 原型阶段提前承诺最终形态。
3. 托盘阶段需要验证窗口隐藏时任务继续、高风险动作等待用户时能够唤醒 UI，以及 Worker 崩溃检测、重启、日志和升级边界。
4. 远程 IM/webhook 是否允许云 Relay，以及哪些原始内容、凭据、附件能离开本机。
5. 后续 macOS/Linux 是否要求与 Windows 同期；当前 `execute_shell` 和 native window 行为需要平台 adapter。
6. 是否允许未来 Web/mobile 只作为客户端连接本地 Core；若允许，需要稳定 RPC、身份和并发写入协议。

## 8. PI 适配准备度矩阵

| 模块                                          | 建议状态                | 原因                                                |
| --------------------------------------------- | ----------------------- | --------------------------------------------------- |
| Document/Knowledge repositories               | 保留                    | 已有 ports、revision、canonical projection 与测试   |
| Rust document transaction                     | 必须长期保留            | 是 Patch 安全、审计和 rollback 的可信边界           |
| Tool Registry metadata                        | 保留并单源化            | 风险、tag、call cap 有价值；schema 需合并           |
| Tool executors                                | 大部分保留              | 已是 Domain result 协议，适合外包一层 PiToolAdapter |
| MCP Client                                    | 保留                    | Rust rmcp 已支持 stdio/http/resource/cancel/trust   |
| Skill loader                                  | 保留                    | summary + 按需读取适合作为 Runtime context hook     |
| Context Bundle / ExecutionPolicy              | 保留                    | 是运行可审计和权限收敛核心                          |
| AI SDK `ToolLoopAgent`                        | PI prototype 后决定替换 | 当前生产可用，但与目标 PI core 职责重叠             |
| Ask/Edit 手写 Provider path                   | 应逐步统一              | 与 Agent path 重复；不宜在第一步大爆炸迁移          |
| `useAgentRun` UI 状态                         | 拆成 client projection  | 不能成为 daemon/core runtime owner                  |
| `agent_workspace_state` conversation snapshot | 短期兼容，长期拆分      | 适合 UI aggregate，不适合后台可恢复 run log         |

## 9. 建议的最小验证性原型范围

这不是最终迁移计划，只是用于回答“PI 能否低成本接入”的最小证据：

1. 在新 package 中只定义 PI Runtime port 与 `DomainTool -> PiToolAdapter`，不访问 SQLite。
2. 复用现有 Provider 或临时 `streamFn`，完成一次 `search_documents -> read_document -> final answer`。
3. 再加入一个 `mcp__...` 只读工具，验证 schema、MCP error、progress、call ID 和 cancel。
4. 最后加入 `submit_document_edits`，只生成现有 `AgentPatchSet`，继续走原 UI Diff 和 Rust transaction。
5. 对照保存 tool audit、Context Bundle、usage、finish reason；确认不会产生第二套 Tool Registry、MCP Client 或文档写入协议。

原型完成后只决定 Runtime 实现：保留 AI SDK、仅用 `pi-agent-core` 接现有模型层，或同时采用 `pi-ai`。Worker 的进程演进顺序与 Rust 数据所有权已经由路线图确定，不在此原型中重新二选一。

## 10. 供评审者继续阅读的文件

```text
src/models/agent/agent.ts
src/models/agent/agentRuntime.ts
src/models/agent/agentRunLifecycle.ts
src/models/agent/agentTool.ts
src/models/agent/executionPolicy.ts
src/models/agent/contextBundle.ts
src/models/ai/ai.ts
src/models/ai/aiChatHistory.ts
src/models/integrations/mcp.ts
src/models/integrations/skill.ts

src/services/ai/AiSdkProvider.ts
src/services/ai/AiMarkdownService.ts
src/services/ai/AiHttpService.ts
src/services/ai/agentRuntime/agentRuntimeStream.ts
src/services/agent/AgentToolLifecycle.ts
src/services/agent/AgentResourceDraftService.ts
src/services/integrations/SkillService.ts

src/infrastructure/database/agent/AgentWorkspaceHistoryStore.ts
src/infrastructure/database/agent/TauriAgentRepository.ts
src/infrastructure/integrations/TauriMcpClient.ts
src/features/workspace/components/home/useAgentCommunicationWorker.ts

src-tauri/src/mcp.rs
src-tauri/src/skills.rs
src-tauri/src/agent_tools.rs
src-tauri/src/agent_repository.rs
src-tauri/src/database.rs
src-tauri/src/ai_proxy.rs
src-tauri/src/bin/mynotebook-mcp.rs
src-tauri/src/bin/mynotebook-agent.rs

docs/architecture.md
docs/agent-runtime.md
docs/database.md
docs/mcp-client.md
docs/automations.md
docs/email-inbox.md
docs/roadmap.md
```
