# 当前架构与模块边界

本文是 MyNoteBook 当前架构的事实入口，已按 2026-08-08 代码与 migration `0001`–`0046` 复核。它描述已经存在的实现、代码所有权和必须保持的依赖方向。产品定位、工作循环与品牌原则见 [产品定位与愿景](product-positioning.md)；认知系统契约见 [认知系统集成](cognitive-system-integration.md)，未完成事项和目标边界见 [后续开发路线图](roadmap.md)。

## 1. 产品与技术边界

MyNoteBook 的产品类别是本地优先的 AI 桌面工作中枢。它通过收集、理解、组织、委派、表达和沉淀的持续循环，为知识工作保留可继续的上下文。当前技术实现由 Vue 3 + Tiptap 前端、Tauri/Rust 桌面壳和 SQLite 本地存储组成，是单机桌面应用，不是 React 应用，也不是由多个服务组成的分布式系统。

生产 Agent Runtime 使用真实 AI SDK Node sidecar、Rust Supervisor/dispatcher、Tauri Runtime Adapter 和自包含 SEA `externalBin`。`useAgentRun` 仅冻结交互输入、订阅事件、授权/取消与 UI projection；它不再为 sidecar 路径组装 Task、Context Bundle、ExecutionPolicy、Tool Manifest 或 `AgentRunRequestV1`。关闭主窗口会隐藏到托盘，Rust watcher/sidecar 与 Durable Timer 在无窗口时继续运行。Phase 6 已增加独立 Headless Core 控制进程和带随机凭证的 loopback 协议；WebView 数据库 catalog 与 Durable Timer 已迁入该进程，但其他 Rust 领域数据库访问、watcher 与 Worker Supervisor 尚未迁移，显式退出 Desktop 仍会停止这些剩余业务 Runtime。Rust 是 SQLite 唯一写入者，WebView 不持有 SQLite handle 或 SQL capability。

产品愿景不能改变当前事实边界：尚未实现的信息来源、后台能力和外部应用接入必须明确标记为未来方向；Agent、View 和模型输出不能被宣传或实现为绕过用户判断的第二事实源。

当前系统包含八个相互约束的领域：

| 领域          | 当前职责                                                                              |
| ------------- | ------------------------------------------------------------------------------------- |
| Document      | Tiptap JSON 写真源、稳定 block ID、plain text/block/FTS 投影、revision 和附件         |
| Agent Runtime | 模型调用、工具循环、上下文编译、ExecutionPolicy、结构化提案和运行审计                 |
| Knowledge     | 版本化 Knowledge Object、关系、来源锚点、有效期与权威等级                             |
| Work          | TaskDefinition/TaskRun、Artifact/Evidence、Result Verification、ChangeSet 与 Approval |
| View          | Query/Projection/Generated View、依赖快照、stale 和 override 保护                     |
| Integration   | Skills、MCP Client、只读 MCP Server、CLI Agent Adapter 和 Provider 适配               |
| Governance    | Delegation capability、外部提交、幂等、Domain Event 与 Transactional Outbox           |
| Cognition     | 版本化 Mode/Template、CognitiveRunSpec、Output Contract、Session 和知识候选控制       |

Document Core 是规范文档的唯一写边界。Knowledge、Work、View、Agent 和外部集成都不能绕过它直接修改正文。

## 2. 运行数据流

### 文档写入

```text
Vue/Tiptap 编辑状态
  -> DocumentRepository
  -> Rust document_core::persist_document
  -> 校验 Tiptap JSON 与稳定 block ID
  -> 生成 plain_text / blocks / FTS 投影
  -> 单个 SQLx transaction 提交
```

`documents.content_json` 是正文写真源。`plain_text`、`blocks` 和 `document_search` 是可修复投影，不接受独立业务写入。

### 交互式 Agent

```text
用户消息或 Slash Command
  -> useAgentRun
  -> AgentRuntimeClient / Runtime Port
  -> AgentRun Command / Event / Reducer
  -> Lifecycle state machine + intent strategy
  -> Context Bundle + ExecutionPolicy
  -> AiSdkAgentRuntimeAdapter -> AI SDK ToolLoopAgent
  -> 内置 Tools / MCP / Skills
  -> 结构化 command 或 Patch
  -> Diff 与用户确认
  -> Rust Agent transaction
  -> Document Core 校验与写入
```

模型流式输出、工具结果和 MCP 返回值都不能直接成为文档写入。完整协议见 [Agent Runtime](agent-runtime.md)。

默认链路由 Rust 托管 sidecar 拥有：`useAgentRun` 提交冻结交互快照并投影运行事件，sidecar 规划 Task/Context/Policy/Manifest、运行模型循环并编译标准 Agent 的终态 proposal；Rust 持久化 proposal 后才转发终态。WebView Runtime 仅由显式兼容配置启用。

### Knowledge、Work 与 View

```text
Document/Knowledge snapshot
  -> TaskRun + Context Bundle
  -> Artifact / Evidence
  -> Result Verifier
  -> passed / failed / needs_approval / unverifiable
  -> 可选 ChangeSet + Approval
  -> 既有 Patch/Document Core 写入边界
```

Knowledge Object 可锚定 document/block/revision。Context Compiler 已读取当前有效的 Rule/Decision。View 只保存可重建快照和依赖，不是第二事实来源。

### 外部委派

外部 Agent 通过 capability-scoped Delegation 读取冻结 Context Bundle 和 TaskRun，并提交 Artifact、Evidence、Result 或 ChangeSet。外部 Result 只进入 Verifier，外部 ChangeSet 只进入审批，不存在 documents 直写接口。状态事实与 Outbox 在同一 Rust transaction 中提交。

## 3. Rust 模块所有权

- `lib.rs`：应用组合、插件初始化和 command 注册，不实现领域规则。
- `core_server.rs`：无 Tauri Headless Core 进程入口、loopback endpoint、随机实例身份、健康检查、协议协商、数据库 catalog、Durable Timer 生命周期和显式维护关闭。
- `core_supervisor.rs`：Desktop 对 Headless Core 的发现/拉起与脱敏状态投影；不在 Desktop 退出时关闭 Core。
- `database.rs`：数据库路径、连接池、迁移、旧库基线和可靠性设置。
- `database_mutations.rs`：WebView repository 写入使用的封闭 mutation catalog、参数校验与固定 SQL；Tauri command 通过 Headless Core 协议执行 catalog。
- `database_queries.rs`：WebView 参数化读取的只读 SQL、行序列化与连接关闭边界；Tauri command 通过 Headless Core 的只读 SQLx pool 执行。
- `document_core.rs`：可信文档校验、投影生成、持久化和修复。
- `agent_repository.rs`：Agent task、Context Bundle、Patch、事务与审计持久化。
- `agent_tools.rs`：数据库工具、只读命令和 Rust 线性时间正则执行。
- `agent_cancellation.rs`：按 tool call ID 取消正在运行的原生或 MCP future。
- `agent_worker_supervisor.rs`：Phase 3 Worker 子进程身份、NDJSON 通道、heartbeat、重启、活动/待授权/待领取终态的脱敏快照、标准 proposal 的原子持久化、崩溃终态、Provider 流式代理，以及全部内置 Domain Tool/MCP 的受控分发；默认生产 Agent 由它监督。
- `agent_request_watcher.rs`：后台 Runtime Profile、A2A lease 原子领取与自动调度、审批/修订状态机、按 `run_id` fencing 的请求/Cognitive 终态、Research candidate 原子持久化、指数退避、Dead Letter 和启动恢复扫描。
- `automation_runtime.rs`：自动化到期入队、原子领取、文档/RSS 输入冻结、只读 Sidecar Agent 提交、来源游标、lease/retry/Dead Letter 和启动恢复。
- `signal_runtime.rs`：消费相关更新领域事件，冻结邮件/RSS/IM/会议与个人工作上下文，提交自主 `signal` Agent，并持有本地待办/日历写入的权限、幂等和运行恢复边界。
- `workflow_timers.rs`：运行于 Headless Core 的绝对 UTC Durable Timer、等待条件、lease/retry/Dead Letter 与 Domain Event/Outbox 原子触发；Desktop 侧仅保留脱敏快照事件投影。
- `reliability.rs`：A2A、自动化、Timer 与 Rust Outbox dispatcher 共享的有界 RetryPolicy、lease clamp 和 UTC clock。
- `ai_models.rs` / `ai_proxy.rs`：Provider 模型列表、请求代理、流式响应和敏感信息边界。
- `work.rs`：TaskRun、Verifier、ChangeSet 和 Approval 的原子状态变更。
- `views.rs`：View snapshot/dependency 发布及 override 保护。
- `governance.rs` / `domain_events.rs`：Delegation、外部提交、幂等、Event 和 Outbox。
- `mcp.rs`：MCP Client Tools/Resources 及 transport 生命周期。
- `mcp_server_exposure.rs`：本地 stdio MCP 暴露配置、能力令牌与允许操作。
- `skills.rs`：Skill 目录、启停、受限文件访问和版本信息。
- `secret_store.rs`：API Key 的 AES-256-GCM 密文与系统凭据库数据密钥。
- `sensitive_data.rs`：工具、Provider、日志和审计内容的凭据检测与脱敏。
- `storage.rs`：数据目录解析、后台 runtime quiesce、受管文件迁移、校验、备份和失败恢复。
- `bin/mynotebook-mcp.rs`：独立 stdio MCP Server；默认只读，能力令牌开启项目目录、A2A 分支和受控任务/审批工具。

Rust command 应立即委托给对应模块。数据库访问必须复用 `database.rs` 管理的路径、迁移和连接设置。

### 目标边界摘要（部分实现）

Agent Runtime、凭据、MCP、A2A Workflow、Durable Timer 和规范 Patch 终态已收敛到 Rust Core 与其托管的 Node sidecar；Node 只通过受控 RPC 调用 Rust 领域工具，禁止直接访问 SQLite。WebView repository mutation 已全部迁入 Rust，读取也只经过 Rust 的只读连接；后续继续收敛连接器和外部副作用。Phase 2 已决定保留 AI SDK 作为唯一生产 Agent Loop；PI 仅保留为已验证的候选 adapter，不接管权限、Workflow、MCP、Skill、Secret 或 Patch transaction。

## 4. 前端模块所有权

- `src/app/composition`：唯一允许组装具体 Tauri/SQLite adapter 与应用服务的位置。
- `src/pages`：薄入口，只选择 provider、注入依赖和转发公开事件。
- `src/features`：面向用户的完整功能面及其局部状态。
- `src/composables`：Vue 生命周期和跨组件响应式工作流。
- `src/services`：应用用例与框架无关的领域编排。
- `src/repositories`：持久化端口；`src/infrastructure` 提供 Tauri/SQLite 实现。
- `src/infrastructure/runtime`：Rust-owned Worker 的生产 Tauri Runtime Port、后台 Profile 同步与事件订阅适配。
- `src/features/knowledge-control/components/AgentRuntimeOperationsPanel.vue`：后台运行的只读运维投影；组合 Worker snapshot event 与 A2A 只读查询，显示 heartbeat/restart、活动 Run、待授权/终态、重试和 Dead Letter，不拥有编排或写入能力。
- `src/models`：领域类型、版本化协议、默认值和纯校验。
- `src/editor`：Tiptap/ProseMirror 集成和编辑器纯算法。
- `src/ui`：不包含产品工作流的通用展示原语。

依赖方向为：composition → feature/page → composable/service → repository/model。`models` 不依赖 Vue、service 或 Tauri；可复用 service 不应直接选择基础设施实现。

### 前端目录约束

扁平层只用于模块入口，业务文件必须继续按领域放入二级目录：

| 区域                          | 二级模块                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/services`                | `agent`、`ai`、`automation`、`cognitive`、`documents`、`knowledge`、`integrations`、`security`、`workspace`、`appearance`、`ports` |
| `src/models`                  | `agent`、`ai`、`automation`、`cognitive`、`documents`、`knowledge`、`integrations`、`workspace`、`settings`、`shared`              |
| `src/repositories`            | `agent`、`audit`、`automation`、`cognitive`、`documents`、`knowledge`、`workspace`、`shared`                                       |
| `src/editor`                  | `components`、`blocks`、`core`、`commands`、`formatting`、`io`、`composables`                                                      |
| `src/infrastructure/database` | `agent`、`audit`、`automation`、`cognitive`、`documents`、`knowledge`、`workspace`、`shared`                                       |

跨模块引用统一使用 `@/` 别名，模块内部不通过旧目录位置建立隐式耦合。前端单元与集成测试保存在 `tests/frontend`，目录结构镜像 `src`，并与源码一起纳入版本控制和 lint。

## 5. 当前公共能力

### Agent 与 AI

- OpenAI、Anthropic、DeepSeek、Qwen 和 OpenAI-compatible Provider。
- Ask、Edit、Agent 及 `/plan`、`/create`、`/interactive`、`/research`、`/review`、`/learn` 等 11 个 Slash 入口。
- AI SDK 原生多轮工具循环、结构化 command/Patch、工具进度、取消和失败审计。
- 新运行生成 Context Bundle v2，并兼容读取 v1；同时保存 ExecutionPolicy、Provider 实际参数与 Skill provenance。
- 25 个内置工具，覆盖当前文档/选区/大纲、FTS5 检索、跨文档和 Mind Map 读取、本机只读诊断、资源草稿与受控修改提案。
- Patch/Diff、逐项确认、revision 冲突保护和安全撤销。
- 代码内版本化 Cognitive Mode/Template Registry、Tool Tag → 工具名权限编译和可插拔 Output Contract。
- 持久化 Cognitive Session，以及带正文、结构化数据、provenance、多来源和 Validation 的 Knowledge Candidate。

### Knowledge、Work、View 与治理

- Rule、Decision、Goal、Task、Evidence、ChangeSet Knowledge Object 及关系。
- TaskDefinition/TaskRun、Artifact/Evidence、Result Verifier、ChangeSet/Approval。
- Query/Projection/Generated View、依赖快照、stale、manual override 和显式分叉。
- MCP Tools/Resources Client、只读 MCP Server、CLI Delegation 和外部提交。
- 本地 Agent 项目/任务树、资料范围、A2A 分支路由、请求修订和版本化 decision envelope。
- Mind Map 与 Slidev/UML/Table 结构化工作区；结构化视图支持树形组织、revision history 和置顶。
- 普通文档 Markdown/JSON 导入，以及 PDF、DOCX、XLS/XLSX、PPTX、CSV、文本和 AI 对话归档的知识资产导入。
- Domain Event、Transactional Outbox、lease/retry 和统一审计读取。

## 6. 必须保持的安全不变量

1. 模型和外部工具不能直接更新规范文档或正式知识。
2. 文档修改必须经过 command/Patch、本地验证、用户确认和 Rust transaction。
3. 工具执行前必须先写 `running` 审计；审计失败时不执行工具。
4. MCP Server 本地信任和工具 `readOnlyHint` 必须同时满足才可免 `executionAuthorization`；可信但可写的工具仍需逐次或本任务授权。
5. Context Bundle、来源 revision、ExecutionPolicy 和 Provider 参数必须可追溯。
6. View、Artifact、模型回复和外部 Result 都不是事实来源。
7. 已发布 migration 不修改；Schema 变化只能增加新 migration。

## 7. 当前实现说明与设计债

- `AgentCommandService` 的安全正则执行器已改为由 `src/app/composition` 注入，service 不再选择 Tauri adapter。
- `/research`、`/review` 与 `/learn` 已绑定各自的 Cognitive Mode、Session、Output Contract 和结构化结果 UI；三者复用同一 Agent Runtime 与 Tool Tag 编译，不存在第二套 Runtime。Learning 使用持久化 `waiting_user` state 跨 run 恢复。
- Runtime 已支持可插拔 `AgentOutputContract<T>`，旧 command/Patch 协议保持非认知运行默认；Research 使用独立结构化 contract，不进入旧写入结果解析。
- Tool Tags 已在运行前编译成 `ExecutionPolicy.allowedTools`，Runtime 热路径仍只检查稳定工具名；Mode/Template/Skill 不能扩大基础策略。
- Knowledge Object 已扩展研究候选所需类型、正文、结构化数据、认知 provenance、多来源、Validation 和 rejected 状态；候选 UI 会在接受前重新验证来源 revision 和稳定 block，并只将显式接受项转为 `approved`。
- Run lifecycle、Plan、运行级事件和 tool timeline 已绑定 assistant 消息并持久化；规范工具审计仍保存在独立数据库表中。
- 默认 Agent Runtime 的规划、模型循环、工具调度、MCP manifest 枚举与标准 Patch proposal 编译已移入 sidecar/Rust；Rust 会先持久化这些 proposal，再允许 Vue 显示 Diff。授权 UI 仍由 Vue 投影；普通 Run 仍没有 durable checkpoint/resume。
- Cognitive Session CRUD/终态、A2A 自动领取与 sidecar 调度、审批/拒绝、修订和请求终态均由 Rust 写入。Research candidate、source、validation、Cognitive Session、AgentTask 与请求终态在同一个事务中提交，并使用稳定 projection ID；WebView 只保留交互式投影和审阅入口。
- A2A `running` 请求保存 lease owner/expiry、attempt 和独立 `run_id`；Worker 事件续租，迟到终态必须通过当前 `run_id` fencing，可重试失败使用有上限的指数退避，耗尽后进入 Dead Letter。Rust watcher 启动时依据 Supervisor 活动 Run 快照回收孤儿请求，并终止旧 task/session 后以新 run 重排；这是可审计的 at-least-once 业务恢复，不是模型步骤级 checkpoint/resume 或外部副作用 exactly-once。
- 前端 A2A repository 已映射 `run_id`、cognitive session、attempt、next attempt、Dead Letter、failure kind 和时间字段，并提供最近请求的参数化只读查询。知识中心只订阅 `agent-runtime://worker-status` 与 `agent-communication://queue-changed` 后刷新投影；内部 lease owner 不进入 UI contract。
- Timer scheduler 提供脱敏健康快照，覆盖 last tick/success/error、scheduled/processing/retry/due/dead-letter 数量与最大延迟；调度循环不再静默吞掉数据库、领取或重排错误。Timer schedule/cancel 与 Outbox claim/settle 已退出 WebView `invoke_handler` 和 TypeScript repository，只保留 Rust 内部原语与只读状态投影。
- Domain Event 已冻结 v1 envelope 字段：schema version、source、workspace、deduplication key、security scope、actor、correlation、causation 与 payload。Outbox 失败采用 Rust 内部有界退避，耗尽后进入 Dead Letter；Phase 5 Action Gateway 已持有外部动作审批、幂等、lease、fencing、重试和终态，但尚未注册任何真实外部动作 dispatcher。
- 新 Agent 任务分别保存 `AgentTask.id`（迁移期 work item）、独立 `run_id`、可空 `workflow_id`、conversation/cognitive `session_id` 和 `document_id`；历史记录使用确定性 `legacy-run-*` 映射，`task_runs.id` 保留原有治理语义。
- `tokenBudget` 当前主要约束单次输出参数，没有基于累计 input/output usage、成本、模型轮次和并行工具数的统一预算器。
- Rust SQLx 是唯一数据库连接所有者和唯一写入者；TypeScript repository 只提交固定 mutation ID 或参数化只读 query，不拥有连接池。
- Review 已完成真实 DeepSeek/Tauri smoke；Research、Learning 和 Windows 发布升级的剩余真实环境验收单独记录在路线图，不用历史测试总数代替当前结论。
- Provider 工具名称、Zod/JSON Schema、风险、三类授权、调用上限、tags 和展示元数据由 Domain Tool Catalog 生成；Rust 原生工具仍保留独立安全校验，不能被前端 schema 替代。
- 自动化已由 Rust watcher 领取手动或到期运行，并复用生产 Sidecar 执行只读 Agent；RSS 类型会先同步来源并冻结增量输入。人工、Timer、RSS 与相关更新统一进入 Rust Work Item/Workflow，等待续接创建新的 Run。邮件/统一收件箱刷新和首页人工入口会发布相关更新事件，信号 Agent 可自主读取知识并幂等更新本地待办/日历。更多 IM 收纳、外部委派触发和真实外部动作 handler 仍属于后续集成。

未完成的设计债与验收顺序以 [后续开发路线图](roadmap.md) 为准。

### 当前桌面权限边界

| 能力    | 当前事实                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| CSP     | 生产 CSP 非空；WebView 只连接同源与 Tauri IPC，开发策略仅额外开放 `127.0.0.1:1420` 和对应 HMR WebSocket。      |
| SQL     | 主窗口没有任何 SQL capability；`plugin-sql` 已删除，Rust command 持有固定 mutation catalog 与只读 query pool。 |
| fs      | 不再使用 `fs:default` 或静态目录 scope；系统文件对话框按用户选择动态授权单个文本文件。                         |
| opener  | WebView 只可在显式用户动作中打开 HTTP(S) URL；附件和 Skills 路径由 Rust 校验并从后端打开。                     |
| network | WebView 未授予 HTTP client capability；Provider、MCP 与连接器网络均由 Rust/sidecar 受控路径拥有。              |
