# PI 接入资料：第一批（必须信息）

> 代码核对日期：2026-07-29；分支：`main`。本文只记录当前代码已经存在的能力，并把未来方案明确标成“建议/待定”。
>
> 状态说明：本文作为当前架构快照保留，不是目标架构规范。后续既定方向、PI 决策门和迁移阶段以 [后续开发路线图](roadmap.md) 为准。
>
> 脱敏说明：没有读取或收录用户数据目录中的 `editor.db`、`mcp-servers.json`、凭据文件、邮件正文或真实运行日志。仓库扫描未发现真实 API Key、Token、密码或私有服务地址；测试中的 `current-key` 是固定假值。公开 Provider 默认地址保留。

## 0. 先给结论

- 当前是一个根包的 pnpm workspace，不是多 package monorepo。Vue 前端在 `src/`，Tauri/Rust 在 `src-tauri/`。
- 当前没有 Node Runtime 或 PI package；Node `>=22.12.0` 只用于前端开发/构建。`tauri.conf.json` 没有 `bundle.externalBin`，因此也没有 Node sidecar 打包方案。
- Agent Loop 运行在 Vue/WebView 的 TypeScript 中，生产 Agent 使用 Vercel AI SDK v7 `ToolLoopAgent`。Rust 不拥有 Agent Loop，也不直接调用 LLM SDK；Rust 通过 Tauri Channel 代理模型 HTTP 流。
- Rust 是数据库 schema、migration、关键多语句事务和原生能力的权威实现；但 TypeScript repositories 也通过 `@tauri-apps/plugin-sql` 直接读写同一个 SQLite。因此当前是“双数据访问路径”，不是严格的单一数据库进程所有者。
- 文档写工具不会让模型直接写 SQLite。Agent 只捕获 Patch/command 提案，用户确认后才调用 Rust transaction 写入，并保存 before/after 与 rollback 记录。
- MCP Client 和 Skill 文件系统在 Rust；MCP tool 转换、Agent 策略、上下文和模型循环在 TypeScript。
- 当前应用关闭后 Agent、A2A 轮询和自动化执行不会继续；没有托盘、开机启动、后台 daemon 或后台模型 worker。

## 1. 项目目录结构

以下为核心 3～4 层目录；已排除 `node_modules/`、根 `target/`、`src-tauri/target/`、`dist/`、截图与测试输出。

```text
myNoteBook/
├─ package.json
├─ pnpm-workspace.yaml
├─ pnpm-lock.yaml
├─ vite.config.ts
├─ tsconfig.json
├─ tsconfig.app.json
├─ tsconfig.node.json
├─ playwright.config.ts
├─ eslint.config.ts
├─ src/                                  # Vue 3 / TypeScript 前端
│  ├─ main.ts
│  ├─ App.vue
│  ├─ app/composition/                   # Service/Repository 组合根
│  ├─ composables/
│  │  ├─ useAgentRun.ts                  # 前端 Agent 总编排入口
│  │  ├─ useAgentPatchWorkflow.ts        # Patch 审批、应用、撤销
│  │  ├─ useAiConversation.ts
│  │  ├─ agentRun/                       # prepare/context/runtime/output/persistence
│  │  ├─ aiHistory/                      # 对话快照持久化
│  │  └─ documentWorkspace/
│  ├─ editor/
│  │  ├─ blocks/                         # Tiptap 自定义块与 block registry
│  │  ├─ commands/                       # Agent Patch、slash command 等
│  │  ├─ components/                     # 文档编辑器 UI
│  │  ├─ core/
│  │  └─ io/                             # Markdown/JSON/附件导入导出
│  ├─ features/
│  │  ├─ ai-chat/components/
│  │  ├─ documents/components/
│  │  ├─ knowledge-control/components/
│  │  ├─ automation/components/
│  │  ├─ inbox/components/
│  │  ├─ integrations/{mcp,skills,email,rss,dingtalk}/
│  │  ├─ workspace/components/
│  │  └─ workspace-views/components/
│  ├─ models/
│  │  ├─ agent/                          # Task/Tool/Runtime/Policy/Context 类型
│  │  ├─ ai/                             # Provider、消息历史
│  │  ├─ cognitive/                      # Research/Review/Learning
│  │  ├─ documents/
│  │  ├─ integrations/                   # MCP/Skill 类型
│  │  └─ knowledge/
│  ├─ repositories/                      # 领域 Repository ports
│  │  ├─ agent/
│  │  ├─ documents/
│  │  ├─ knowledge/
│  │  └─ shared/
│  ├─ infrastructure/
│  │  ├─ database/
│  │  │  ├─ agent/
│  │  │  ├─ documents/
│  │  │  ├─ knowledge/
│  │  │  ├─ automation/
│  │  │  ├─ inbox/
│  │  │  └─ shared/connection.ts         # plugin-sql + prepare_database
│  │  ├─ integrations/TauriMcpClient.ts
│  │  ├─ assets/
│  │  └─ transfer/
│  └─ services/
│     ├─ agent/
│     │  ├─ AgentRuntime.ts
│     │  ├─ AgentToolRegistry.ts
│     │  ├─ AgentToolExecutor.ts
│     │  ├─ AgentRunEngine.ts
│     │  └─ toolExecutors/
│     ├─ ai/
│     │  ├─ AiSdkAgentRuntime.ts
│     │  ├─ AiSdkProvider.ts
│     │  ├─ AiMarkdownService.ts
│     │  └─ agentRuntime/                 # Tool schema/lifecycle/stream
│     ├─ cognitive/
│     ├─ integrations/SkillService.ts
│     ├─ knowledge/
│     └─ ports/
├─ src-tauri/                             # Tauri 2 / Rust 后端
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ capabilities/default.json
│  ├─ migrations/0001...0035_*.sql
│  ├─ test-fixtures/
│  └─ src/
│     ├─ main.rs
│     ├─ lib.rs                           # setup、plugins、command 注册、migrations
│     ├─ database.rs                      # SQLx pool/WAL/migrate/backup
│     ├─ document_core.rs                 # canonical Tiptap 校验与投影
│     ├─ agent_repository.rs              # Patch apply/rollback transaction
│     ├─ agent_tools.rs                   # Rig ToolSet + SQLite/系统只读工具
│     ├─ agent_cancellation.rs
│     ├─ ai_proxy.rs                      # 模型 HTTP 流代理
│     ├─ ai_models.rs
│     ├─ mcp.rs                           # MCP Client (stdio/http)
│     ├─ mcp_server_exposure.rs           # 本地 stdio MCP Server 配置
│     ├─ skills.rs
│     ├─ secret_store.rs
│     ├─ storage.rs
│     ├─ email.rs / rss.rs / dingtalk.rs
│     ├─ work.rs / governance.rs / views.rs
│     └─ bin/
│        ├─ mynotebook-mcp.rs              # 独立 stdio MCP Server
│        └─ mynotebook-agent.rs            # 独立 MCP CLI Client
├─ tests/
│  ├─ frontend/                           # Vitest，按领域镜像 src
│  ├─ e2e/
│  └─ browser/                            # 本地演示/验收资产
└─ docs/                                  # 架构、Agent、DB、MCP、路线图
```

仓库不存在根 `packages/`、`server/` 或独立 `agent/` package；Agent 代码分布在 `src/composables`、`src/services`、`src/models`、`src/infrastructure` 和 `src-tauri/src`。

## 2. 依赖与构建配置

### 2.1 工作区形态

`pnpm-workspace.yaml`：

```yaml
packages:
  - '.'
allowBuilds:
  esbuild: set this to true or false
  vue-demi: set this to true or false
```

结论：语法上是 workspace，实际只有根 package。若 PI 以 Node Runtime 接入，当前仓库还没有可承载它的 `packages/runtime`、RPC package 或独立发布单元。

### 2.2 `package.json`

以下是为评审重组的决策字段与关键依赖摘要，不是可直接覆盖原文件的 JSON；完整依赖清单和精确版本以根 `package.json` 为准。

```json
{
  "name": "my-notebook",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.12.4",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "typecheck": "vue-tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest",
    "test:run": "vitest run",
    "e2e": "playwright test"
  },
  "keyDependencies": {
    "vue": "^3.5.38",
    "ai": "^7.0.22",
    "@ai-sdk/anthropic": "^4.0.12",
    "@ai-sdk/openai-compatible": "^3.0.7",
    "@tauri-apps/api": "^2.11.1",
    "@tauri-apps/plugin-sql": "^2.4.0",
    "@tiptap/vue-3": "^3.27.1",
    "zod": "^4.4.3",
    "yaml": "2.9.0"
  },
  "engines": {
    "node": ">=22.12.0",
    "pnpm": ">=10.0.0"
  }
}
```

上面省略的 UI/编辑器依赖包括 Slidev、VTable、Mermaid、Mind Elixir、PDF.js、Mammoth、JSZip、KaTeX 等。关键点是：已经依赖 AI SDK，但没有 `pi-ai`、`pi-agent-core` 或 Node 服务框架。

### 2.3 Vite 与 TypeScript

`vite.config.ts` 的有效配置：

```ts
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  test: { environment: 'jsdom', globals: true, include: ['tests/frontend/**/*.test.ts'] },
})
```

`tsconfig.json` 只引用 `tsconfig.app.json` 与 `tsconfig.node.json`；应用 include 为 `src/**/*.ts`、`src/**/*.vue`、`tests/frontend/**/*.ts`，没有 Node Runtime tsconfig 或跨 package project reference。

### 2.4 `src-tauri/Cargo.toml`

核心依赖：

```toml
[package]
name = "my-notebook"
version = "0.1.0"
edition = "2021"
default-run = "my-notebook"

[lib]
name = "my_notebook_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[dependencies]
aes-gcm = "0.10"
keyring = "4.1"
reqwest = { version = "0.13", default-features = true }
rig-core = { version = "0.39", default-features = false }
rmcp = { version = "2.2", default-features = false, features = ["client", "server", "macros", "transport-io", "transport-child-process", "transport-streamable-http-client-reqwest", "transport-streamable-http-server"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "migrate"] }
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-log = "2"
tauri-plugin-opener = "2"
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-window-state = "2"
tokio = { version = "1", features = ["process", "time", "io-util", "io-std", "rt-multi-thread", "macros"] }
tokio-tungstenite = { version = "0.30", features = ["rustls-tls-webpki-roots"] }

[target.'cfg(windows)'.dependencies]
winreg = "0.52"
windows-sys = { version = "0.61", features = ["Win32_Foundation", "Win32_Graphics_Dwm", "Win32_System_LibraryLoader"] }
```

`rig-core` 只用于 Rust 原生 ToolSet，不负责生产 LLM loop。`rmcp` 同时用于 MCP client/server。

### 2.5 Tauri 配置、权限与 sidecar

`src-tauri/tauri.conf.json` 的关键内容：

```json
{
  "productName": "myNoteBook",
  "identifier": "com.local.mynotebook",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://127.0.0.1:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "myNoteBook",
        "visible": false,
        "decorations": false,
        "transparent": true,
        "width": 1200,
        "height": 820,
        "minWidth": 900,
        "minHeight": 620
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  },
  "plugins": { "sql": { "preload": ["sqlite:editor.db"] } }
}
```

`src-tauri/capabilities/default.json` 对 `main` 窗口启用：窗口控制、dialog、fs、log、opener、window-state，以及 SQL `load/select/execute/close`。这意味着 WebView repository 可以直接执行参数化 SQL。

当前 sidecar 结论：

- `bundle.externalBin` 不存在；没有 Node 可执行文件、PI Runtime 或 RPC daemon 的打包配置。
- `src-tauri/src/bin/mynotebook-mcp.rs` 和 `mynotebook-agent.rs` 是 Rust Cargo binaries，不等于已配置的 Tauri external sidecar。
- stdio MCP 可按用户配置启动任意指定 executable；测试 fixture 使用系统 `node`，但安装包没有承诺自带 Node。
- `bundle.targets = "all"` 是产物目标声明，不等于 macOS/Linux 已完成发布验收。

## 3. 当前 Agent Runtime 核心代码

### 3.1 真实调用链

```text
AiChatComposer / WorkspaceSurface
  -> useAgentRun.run()
  -> prepareAgentRun()
       解析 slash command / Auto 模式
       捕获文档、项目、选区、Provider 快照
       创建并持久化 AgentTask
       编译 Context Bundle / ExecutionPolicy / Skill 摘要
       MCP tools/list -> AgentExternalTool[]
  -> mode 分发
       Ask  -> runAiMarkdownCompletion()（手写 SSE/Anthropic stream）
       Edit -> runAiMarkdownCompletion()（agent-json，非多轮 ToolLoopAgent）
       Agent -> runAgentToolLoop()
                 -> runAiSdkAgent()
                 -> buildAgentToolSet()
                 -> AI SDK ToolLoopAgent.stream()
                 -> executeTracked() -> executeAgentTool()/MCP/Tauri Rust
                 -> Observation 返回 AI SDK，继续下一 step
                 -> 本地解析/校验终态
  -> resolveAgentRunOutput()
  -> persistAgentRunResult()
  -> 若有 Patch：进入 useAgentPatchWorkflow 待用户确认
```

### 3.2 应优先提供给 PI 评审者的文件

| 文件                                                          | 作用                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/composables/useAgentRun.ts`                              | 用户输入到运行完成的总编排、Vue 状态、取消、MCP/Skill/Context 接线 |
| `src/composables/agentRun/agentRunPreparation.ts`             | Auto/Ask/Edit/Agent 分发、snapshot、任务持久化、认知 session 恢复  |
| `src/services/agent/AgentRuntime.ts`                          | Runtime 输入/输出/进度接口；动态加载生产实现                       |
| `src/services/ai/AiSdkAgentRuntime.ts`                        | AI SDK Agent 入口和单 run mutable context                          |
| `src/services/ai/agentRuntime/agentRuntimeStream.ts`          | `ToolLoopAgent`、stream、step 限制、结构化输出修复                 |
| `src/services/ai/agentRuntime/agentRuntimeToolDefinitions.ts` | 内置/MCP Tool schema 到 AI SDK ToolSet                             |
| `src/services/ai/agentRuntime/agentRuntimeToolLifecycle.ts`   | Tool Call 审计、重试、去重、失败上限、并发追踪                     |
| `src/services/agent/AgentToolExecutor.ts`                     | Domain tool dispatcher 与统一结果类型                              |
| `src/composables/agentRun/agentRunToolExecutorFactory.ts`     | 文档/MCP/Rust/草稿/授权依赖装配                                    |
| `src/composables/useAgentPatchWorkflow.ts`                    | 提案确认、revision 校验、Rust transaction、撤销                    |

核心入口接口：

```ts
export interface AgentRuntimeInput {
  taskId: string
  prompt: string
  context: string
  settings: AiSettings
  systemPrompt: string
  signal?: AbortSignal
  createId: () => string
  executeTool: (request: AgentToolRequest) => Promise<AgentToolExecutionResult>
  recordToolCall: (call: AgentToolCall) => Promise<void>
  requestAuthorizerInput?: (request: Omit<AgentAuthorizationRequest, 'id'>) => Promise<string>
  externalTools?: AgentExternalTool[]
  executionPolicy?: ExecutionPolicy
  outputContract?: AgentOutputContract<unknown>
  onDelta?: (delta: string, channel?: 'content' | 'reasoning') => void
  onProgress?: (update: AgentProgressUpdate) => void
}
```

### 3.3 对关键问题的直接回答

| 问题                    | 当前实现                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent Loop 自写还是 SDK | 生产循环使用 AI SDK v7 `ToolLoopAgent`；工具策略、审计、写入提案、上下文和 UI 状态是自写。旧 JSON 协议仍用于 Edit/兼容输出。                                                                                             |
| 状态保存                | Vue refs 保存活跃状态；`agent_workspace_state.state_json` 保存项目/对话/消息/运行视图快照；`agent_tasks`、`task_runs`、`agent_tool_calls`、Patch/confirmation/transaction 表保存规范化审计。                             |
| 流式输出                | 支持 content/reasoning 两通道；Agent 迭代 `fullStream`，Ask/Edit 手写解析 SSE；Rust `proxy_ai_request` 用 Tauri `Channel` 传 chunk。                                                                                     |
| 工具串行/并行           | AI SDK 可在同一步并行执行互不依赖的 tool call；`inFlightTools` 跟踪并在错误/取消后 `allSettled`。有依赖的轮次由模型按 Observation 串行推进。策略中没有显式 `maxParallelTools`。                                          |
| 取消                    | 每 conversation 一个 `AbortController`；MCP/原生工具携带 `callId` 调 Rust cancellation registry，Rust future 用 `tokio::select!` 退出；shell `kill_on_drop(true)`。模型 HTTP 代理没有独立 call-id cancellation command。 |
| 工具错误                | 统一 `{ok,value,error,errorCode,retryable,retryAfterMs}`；只读瞬态错误指数退避，最多 `min(maxRetries,4)`；同参失败拒绝重放；累计失败达上限终止。                                                                         |
| 循环限制                | 默认 48 tool rounds、15 分钟、10 次 tool failures、4 次 SDK retries；normalize 上限为 96 rounds/45 分钟/20 failures/8 retries。每工具另有 per-task call cap。                                                            |
| Token 限制              | `tokenBudget` 会限制 `maxOutputTokens`，写提案默认至少请求 16,384 输出 token；usage 会返回并审计。代码没有按累计 input+output usage 在每轮后扣减并强制停止的独立预算器。                                                 |
| Provider/Runtime 耦合   | Agent Runtime 直接构造 AI SDK `LanguageModel` 和 `ToolLoopAgent`；Ask/Edit 走另一套手写 Provider HTTP。不存在独立 `streamFn` port。                                                                                      |
| 可暂停/恢复             | 可在同一次前端运行中等待授权；Learning Session 可跨 run 恢复。普通 Agent 执行不能在应用重启后从中间 tool step 恢复，只会把中断任务标记失败；待确认 Patch 可恢复。                                                        |

## 4. Tool 定义与执行方式

### 4.1 四层结构

```text
AgentToolRegistry                 # name/risk/confirmation/call cap/tags
  -> agentRuntimeToolDefinitions # Zod/JSON Schema + AI SDK tool()
  -> AgentToolExecutor            # Domain dispatcher + result protocol
  -> TS executor / Tauri command / MCP client / proposal capture
```

代表性工具：

| 工具                    | 类型           | Schema/执行                                                                          | 权限与副作用                                                                                                    |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `search_documents`      | 只读           | `{query, limit<=10, scope}`；Rust `SearchDocumentsTool` 查询 SQLite FTS5             | policy + registry call cap 24；workspace/global scope；返回 id/title/snippet/revision                           |
| `read_document`         | 只读           | `{documentId,cursor,maxChars,blockIds}`；Rust 分页读 canonical block，TS 转 Markdown | 只能读工作区或本次 global search 发现的文档；记录 provenance；相同读取复用 Observation                          |
| `submit_document_edits` | 修改提案       | Zod `documentEditProposalSchema`；Runtime 内捕获，不调用 DB executor                 | `risk=write`、`requiresConfirmation=true`；校验本次读取的 document/revision/block，最终进入 Diff 确认           |
| `create_skill_draft`    | 有副作用       | `{name,description,instructions}`；TS service + Rust Skill commands                  | 先 `request_authorizer_input`；只写本地停用 Skill 草稿，不启用                                                  |
| `mcp__<server>__<tool>` | 外部           | MCP 原始 JSON Schema -> AI SDK `jsonSchema()` -> Rust `rmcp`                         | **当前代码只按 server trusted 决定是否免确认**；`readOnlyHint` 只影响 tag/重试。支持 call-id 取消和 30s timeout |
| `execute_shell`         | 本机只读副作用 | command enum + args/timeout/output cap；Rust 固定白名单                              | 只允许受限 PowerShell 查询、只读 git/rg 与版本查询；禁止脚本字符串和写命令                                      |

统一结果协议：

```ts
interface AgentToolExecutionResult {
  ok: boolean
  value?: unknown
  error?: string
  errorCode?: string
  retryable?: boolean
  retryAfterMs?: number
}
```

Tool Call 审计：

```ts
interface AgentToolCall {
  id: string // Runtime 生成的稳定 call id
  taskId: string
  toolName: string
  argumentsJson: string // 写入前脱敏
  resultJson: string | null
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rejected'
  startedAt: number
  completedAt: number | null
  error: string | null
}
```

进度通过 `AgentProgressUpdate` 和 `AgentTimelineEvent` 推给 Vue；开始和完成状态分别写入 `agent_tool_calls`。参数、结果和错误经过 `SensitiveDataRedaction`。目前 schema 不是单源：Registry 元数据、TS Zod、Rust Rig `ToolDefinition` 和部分 UI 展示仍各自维护，这是 Adapter 设计的首要约束。

### 4.2 DomainTool → PiToolAdapter 可复用性

可直接保留的部分：

- `AgentToolDefinition` 的 name/risk/confirmation/maxCalls/tags；
- `AgentToolExecutionResult` 错误与重试协议；
- `AgentToolExecutor` 及其 document/mind-map/system/interactive/draft executors；
- `AgentToolLifecycle` 的审计、失败上限、去重、取消与进度事件；
- MCP 的 `AgentExternalTool` 转换和本地信任/确认逻辑；
- 文档 provenance、revision、Patch 本地校验和 Rust transaction。

需要先收敛再适配的部分：

- Zod/JSON Schema/Rust schema 重复；
- AI SDK `ToolSet` 的 `execute` 闭包与 lifecycle context 绑在一起；
- 部分工具由 TS 直接执行，部分由 Rust，MCP 又返回原生 MCP payload；
- `requiresConfirmation` 对文档写工具表示“最终 Patch 审批”，对草稿/MCP 表示“调用前授权”，语义需要拆分；MCP 的 `readOnlyHint` 尚未进入免确认判定。

## 5. Tauri 和 Rust 当前负责什么

`src-tauri/src/main.rs` 只有：

```rust
fn main() {
    my_notebook_lib::run()
}
```

`src-tauri/src/lib.rs` 完成窗口 setup、状态注入、35 个 SQL migration 注册、plugin 初始化和全部 command 注册。

| 能力       | Rust 当前职责                                                                        | 前端入口                                            |
| ---------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| SQLite     | SQLx migration/pool/WAL/backup/restore；关键 transaction；plugin-sql 预载            | `connection.ts`、各 `Tauri*Repository`              |
| 文档/块    | 校验 Tiptap JSON、生成 plain-text/block/FTS 投影、revision CAS、Patch apply/rollback | `TauriDocumentRepository`、`useAgentPatchWorkflow`  |
| 文件       | 附件、导出文件、数据目录迁移、Skill 文件                                             | `AssetService`、SkillService、transfer ports        |
| Agent Loop | **不负责**                                                                           | `useAgentRun` + AI SDK                              |
| 模型请求   | API Key 本地密钥库；模型列表；HTTP/HTTPS 流代理                                      | `AiSecretService`、`AiHttpService`、`AiSdkProvider` |
| 原生 Tools | SQLite 搜索/读取、regex、shell allowlist、系统信息                                   | `RustAgentToolService.executeRustAgentTool`         |
| MCP        | stdio/Streamable HTTP client；本地 stdio server；capability token                    | `TauriMcpClient`、CLI adapter                       |
| Skill      | skills 目录、frontmatter 检查、启停、受限相对路径文件访问                            | `SkillService`                                      |
| 收件箱     | IMAP、RSS、钉钉 Stream、凭据保护与本地同步                                           | inbox repositories/services                         |
| 窗口       | Windows acrylic、圆角、window state、首屏隐藏后显示                                  | `main.ts` + Tauri plugins                           |
| 托盘/后台  | 未实现                                                                               | 无                                                  |

启动流程：Tauri builder setup 主窗口和插件；Vue mount 后 `main.ts` 等待一帧并 `show()`。数据库第一次访问时前端先调用 `prepare_database`，Rust migration/优化完成后再 `Database.load()`。关闭时只有文档 autosave 对 `onCloseRequested` 做等待保护；没有托盘接管或后台进程续跑逻辑。

当前边界不完全符合题目中的 A/B/C：没有 Node；业务编排主要在 Vue，数据库 schema/关键事务在 Rust，但 TS 也直接 SQL。若按“数据事实所有者”判断，Rust migration + transaction 是当前最接近的 canonical owner。后续方向现已确定为 Rust Core 单一所有者、Node 仅通过 RPC 调 Rust，不能保留 TS + Rust + Node 三方写库；具体迁移阶段以路线图为准。

## 6. 数据库结构

### 6.1 初始化与访问

- 文件名：`editor.db`；默认位置是 Tauri app config directory，也可由用户选择数据目录。
- migration：`src-tauri/migrations/0001...0035`，Rust `sqlx::Migrator` 和 Tauri SQL plugin 使用同一组 SQL。
- WAL：开启；`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`。
- Rust SQLx pool：最多 4 connections；关键文档、Patch、Work/View 等写操作有显式 transaction。
- TypeScript：通过 `@tauri-apps/plugin-sql` 直接做 repository CRUD；schema migration 禁止在 TS 执行。

### 6.2 重点表映射

| 需求概念      | 当前表/实现                                                                                       | 说明                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| documents     | `documents`                                                                                       | canonical `content_json` 为 Tiptap JSON；另存 `plain_text`、revision、树结构和软删除                                     |
| blocks        | `blocks`                                                                                          | `(document_id,id)` 主键；保存每个顶层稳定块的 JSON/text/index/document_revision；是 projection，不是另一份可独立编辑事实 |
| conversations | 无独立表                                                                                          | 项目/会话元数据和消息在 `agent_workspace_state.state_json` 版本化快照中                                                  |
| messages      | 无独立表                                                                                          | 同上；消息可包含 reasoning、认知结果和终态 runtime trace                                                                 |
| agent_runs    | 无同名表                                                                                          | `agent_tasks` + 通用 `task_runs` 表达运行；`agent_requests` 是外部/A2A 请求队列                                          |
| tasks         | `agent_tasks`、`task_definitions`、`task_runs`、`automation_tasks`                                | Agent 审计、通用 Work、自动化定义分别存在                                                                                |
| tools         | 无 tool catalog 表；`agent_tool_calls` 保存调用                                                   | Tool Registry 编译在代码中                                                                                               |
| settings      | 无 SQLite settings 表                                                                             | App/AI 非密钥设置在 WebView localStorage；API Key 在 Rust secret store                                                   |
| attachments   | `assets`                                                                                          | 文件落在数据目录 `assets/`，表保存相对路径、hash、MIME、尺寸                                                             |
| revisions     | `documents.revision` + transaction before/after；`mind_map_revisions`、`workspace_view_revisions` | 文档没有通用 append-only revision 表，但 Agent transaction 可撤销                                                        |
| knowledge     | `knowledge_objects`、relations/sources/validations                                                | 支持来源 document/block/revision、authority/confidence/version                                                           |
| event/log     | `domain_events`、`outbox_messages`、`agent_tool_calls`、confirmations、approvals                  | 已有事件/运行/审计基础                                                                                                   |

主要 Agent/Work 表：

```text
agent_tasks
  ├─ agent_tool_calls
  ├─ context_bundles
  ├─ agent_patch_sets -> agent_patches / agent_task_sources
  ├─ agent_confirmations
  ├─ agent_document_transactions / agent_document_creation_transactions
  ├─ change_sets -> approvals
  └─ task_run_id -> task_runs -> work_artifacts / work_evidence / result_verifications

agent_requests -> task_id / previous_task_id / project_id / branch_id
agent_workspace_state -> versioned project/conversation/message JSON snapshot
```

Agent 模型不能执行 SQL，也不能直接写文档表。它可以：执行只读工具；经前置授权创建停用 automation/Skill/MCP 草稿；生成文档 Patch。文档真正写入由用户确认触发 Rust transaction。

## 7. 当前实际运行流程

### 7.1 当前已实现：Agent 修改文档

1. 用户在 `AiChatComposer` 选择 Agent 或 Auto 并发送请求；`WorkspaceSurface` 调 `agentRun.run()`。
2. `prepareAgentRun()` 解析 slash command/Auto，捕获项目、conversation、当前文档、选区和 Provider 快照，保存 `agent_tasks`。
3. Runtime 刷新当前脏文档并重新从 SQLite 读取 canonical revision/blocks；编译 Skill 摘要、Context Bundle 和 ExecutionPolicy。
4. 若 MCP 可用，Tauri/Rust 对已启用 server 执行 `tools/list`，TS 转成 `mcp__...` 工具并加入当前 ToolSet。
5. AI SDK `ToolLoopAgent` 流式请求模型；模型按需调用 `search_documents`、`read_document` 等工具。
6. Tool lifecycle 先写 running audit，Rust 查询 FTS/blocks，结果脱敏后写 completed audit，并作为 Observation 返回模型；独立只读调用可以并行。
7. 模型用 `submit_document_edits` 或其他写入提案工具提交；Runtime 只捕获提案，并校验 document/revision/stable block provenance。
8. `resolveAgentRunOutput()` 生成 `AgentPatchSet`，写 `agent_patch_sets/agent_patches`，任务进入 `waiting_confirmation`，前端显示 Diff。
9. 用户可逐项编辑/接受/拒绝。接受时前端重新加载每个目标文档，检查 dirty/revision/before/block IDs，生成下一份 Tiptap JSON。
10. 前端调用 Rust `apply_agent_patch_set`；Rust 在单个 transaction 中 CAS 更新文档、重建 block/FTS projection、保存 before/after transaction、confirmation/approval，并允许后续 rollback。

语义分类：整个过程是一条 `Agent Run`；每轮模型决策和 tool call 是 Run 内 step；Patch 是 `Action Proposal`；确认弹窗是 `Human Approval`；Rust transaction 是 `Knowledge Mutation`；`agent_tool_calls`、`domain_events` 等是审计/Event。

### 7.2 建议新增但当前未实现：邮件到任务再到回复

```text
后台同步器收到新邮件（Event）
  -> 规则/模型分类到项目（Workflow step，只读）
  -> 提取事实、任务、风险（Agent Run，结构化输出）
  -> 创建/更新 TaskRun 与候选 Knowledge Object（Action Proposal）
  -> 用户确认任务归属与知识变更（Human Approval）
  -> Rust transaction 写入任务/知识（Knowledge Mutation）
  -> 生成回复草稿（Agent Run）
  -> 用户确认外发（Human Approval）
  -> Email connector 发送并写 outbox/domain event（External Action/Event）
```

当前只具备 IMAP TLS 手动增量同步、本地只读邮件副本、本地处理状态、任务/知识/approval/outbox 数据基础；没有后台轮询 worker、邮件发送、托盘/daemon，也没有 UI 关闭后的 Agent Runtime。因此这条流程不能只在现有 Vue `setInterval` 中增加逻辑。

## 8. 最严重的三个架构问题

1. **数据库访问权没有真正单一化。** Rust 掌握 schema 和关键事务，TypeScript repositories 又直接 SQL；若 PI/Node 再直接连接 SQLite，会形成三个 writer 和三套 transaction/cancellation 生命周期。
2. **Tool contract 多处重复，并已出现权限语义偏差。** Registry 元数据、AI SDK Zod schema、Rust Rig JSON Schema、Rust Args、MCP 暴露和 UI 展示并非同一来源。当前代码只用 `serverTrusted` 判断 MCP 是否免确认，`readOnlyHint` 没有参与该判定，与“trusted + readOnly”目标策略不一致；这既是安全风险，也会直接增加 `DomainTool -> PiToolAdapter` 的维护成本。
3. **运行时绑定 WebView 生命周期且状态模型分裂。** Agent/A2A worker 在 Vue 中运行；关闭应用不能继续。对话和终态 trace 是单行 JSON snapshot，执行审计又在规范化表中；普通 run 不能 checkpoint/resume，后台 daemon 也无法仅凭稳定 run record 接管。

次一级问题见第二批资料：双 Provider 路径、累积 Token 预算未强制扣减、普通 Edit 与 Agent 写入协议仍有兼容分支。

## 9. 第一批原始文件清单

建议交给 PI 评审者时至少附上这些仓库文件；本文已经给出职责和关键契约，但不复制超长实现：

```text
package.json
pnpm-workspace.yaml
vite.config.ts
tsconfig.json
tsconfig.app.json
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
src-tauri/capabilities/default.json

src/composables/useAgentRun.ts
src/composables/agentRun/agentRunPreparation.ts
src/composables/agentRun/agentRunToolExecutorFactory.ts
src/composables/useAgentPatchWorkflow.ts
src/services/agent/AgentRuntime.ts
src/services/agent/AgentToolRegistry.ts
src/services/agent/AgentToolExecutor.ts
src/services/ai/AiSdkAgentRuntime.ts
src/services/ai/agentRuntime/agentRuntimeStream.ts
src/services/ai/agentRuntime/agentRuntimeToolDefinitions.ts
src/services/ai/agentRuntime/agentRuntimeToolLifecycle.ts

src-tauri/src/main.rs
src-tauri/src/lib.rs
src-tauri/src/database.rs
src-tauri/src/document_core.rs
src-tauri/src/agent_repository.rs
src-tauri/src/agent_tools.rs
src-tauri/src/agent_cancellation.rs
src-tauri/src/ai_proxy.rs
src-tauri/src/mcp.rs
src-tauri/src/skills.rs
src-tauri/migrations/0001_create_documents_and_assets.sql
src-tauri/migrations/0004_add_agent_audit_and_document_search.sql
src-tauri/migrations/0005_add_agent_tool_calls.sql
src-tauri/migrations/0006_add_document_blocks.sql
src-tauri/migrations/0009_add_p0_trusted_runtime.sql
src-tauri/migrations/0010_add_p1_knowledge_work_views.sql
src-tauri/migrations/0014_add_cognitive_core.sql
src-tauri/migrations/0015_add_agent_communication.sql
src-tauri/migrations/0019_add_agent_workspace_state.sql
```
