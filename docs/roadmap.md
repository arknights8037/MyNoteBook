# 后续开发路线图

本文是 MyNoteBook 未完成工程工作的权威排序，已按 2026-08-08 代码与 migration `0001`–`0046` 复核。当前架构事实见 [系统架构](architecture.md)，生产 Agent 行为见 [Agent Runtime](agent-runtime.md)，事件编排事实见 [事件驱动 Workflow](event-driven-workflows.md)，PI 评审输入见 [PI 接入资料](pi-integration-high-value.md)。

路线图按依赖、交付物和退出条件推进，不承诺未经验证的日历日期。以下标签必须严格区分：

- **当前事实**：主干已经存在，且能从代码、migration 或定向测试复核。
- **既定方向**：后续实现必须遵守的架构边界，但不代表已经完成。
- **决策门**：必须通过原型或验收后才能选择的实现，不能提前写成既定技术栈。

## 1. 当前基线与主要瓶颈

以下能力已经进入主干，不再作为待办重复建设：

- canonical Tiptap JSON、稳定 block ID、revision CAS、block/plain-text/FTS 投影和可靠数据目录迁移。
- 受控 Agent Runtime、ExecutionPolicy、Context Bundle v2、工具审计、重试、取消、脱敏和结构化 Output Contract。
- 文档修改的 Patch → Diff → 人工确认 → Rust transaction → rollback 链路。
- Research、Review、Learning 认知模式、Cognitive Session 和 Knowledge Candidate 审核。
- Knowledge Object、Task/Work、Approval、Domain Event、Transactional Outbox 和外部 Delegation 基础。
- Rust MCP Client/Server、动态 Skill、API Key secret store、IMAP、RSS 和钉钉连接器。
- Slidev、UML、Table、Mind Map、Dashboard 与独立信息首页。
- 托盘常驻、A2A 无窗口执行、持久 lease/retry/Dead Letter，以及通用 Durable Timer/等待条件。
- Rust 唯一 SQLite 写入所有权、WebView 固定 mutation command、只读查询 command 与最小桌面权限。
- 知识中心任务验收页的后台运行控制投影，覆盖 Worker heartbeat/restart、活动 Run、待授权/待领取终态，以及 A2A attempt/retry/Dead Letter。

当前真正限制异步任务、自动化和外部事件发展的不是 Agent 工具不足，而是：

> 默认 Agent 的任务规划、模型循环、工具调度和标准 Patch 终态编译已位于 Rust 托管 sidecar；A2A 自动调度、审批/修订和 Cognitive 终态投影也由 Rust 持有。Vue 只提交交互式快照并投影事件/审阅 UI。

`useAgentRun.ts` 通过 Runtime Client/Port 提交交互式冻结快照并投影运行、授权和 Diff 审阅状态；它不再为标准 Agent 组装 Runtime request、解析模型 Patch 或写入任务/Patch 终态。A2A 队列由 Rust watcher 轮询、领取并启动 sidecar，Vue 不再持有 polling 或 A2A 编排。任务验收页通过 Rust snapshot command、只读查询和 Tauri event 展示后台运行状态，不接管 lease、重试或终态结算。主窗口关闭后应用隐藏到托盘，Run 与业务终态可继续；显式退出整个应用仍会停止进程。后续不得继续围绕前端热路径叠加邮件、IM、定时器或长期 Workflow。

## 2. 当前边界与目标边界

### 2.1 当前事实

```text
Vue / WebView
├── Ask / Edit / Agent / Auto 交互入口
├── Runtime Client / Tauri Adapter
├── 运行事件、授权和 Diff 审阅投影
└── Repository ports
        ↓ 固定 mutation / 只读 query command
Tauri / Rust
├── SQLite migration / pool / WAL / backup
├── SQLite 唯一写入者
├── Agent Worker Supervisor / A2A Workflow
├── Durable Timer / Wait Condition / Outbox
├── Provider proxy / Tool / MCP / Secret
├── canonical document transaction
└── 托盘常驻与后台 watcher
        ↓ NDJSON stdio
Node sidecar
├── SidecarRunPlanner
├── AI SDK ToolLoopAgent
└── Patch / Cognitive 终态编译
```

WebView 已不持有 SQLite handle 或 SQL capability：repository 写操作映射到 Rust 的封闭 mutation catalog，参数化读取通过启用 SQLite 只读保护的 Rust query command 完成。Node sidecar 和托盘已经投入生产；独立 daemon 尚未实现。

### 2.2 既定方向

```text
Vue / Tauri UI
        ↓ Runtime Client
Rust Core
├── SQLite 唯一所有者
├── Event / Workflow 状态
├── Connector / MCP / Skill / Secret
├── Action Gateway / Approval
└── Agent Worker Supervisor
        ↓ 受控 RPC
可替换 Agent Worker
├── Agent Runtime Adapter
├── Model Runtime
├── DomainTool Adapter
└── Run-local Context
```

必须保持以下决策：

1. Rust Core 已是 SQLite 的唯一写入者，并继续收敛连接器、Workflow 状态和外部副作用所有权。
2. Node Worker 永不直接连接 SQLite，只能通过 Rust 提供的受控 RPC 调用领域能力。
3. 从 Phase 0 起禁止新增 WebView 直接写库路径；存量写路径按阶段迁移。
4. 当前 AI SDK Runtime 在决策门完成前仍是唯一生产 Agent Loop。
5. PI 只是 Worker 内部候选实现，不是权限、事实源、Workflow 或数据库边界。
6. Rust MCP、Skill、Secret、Connector 和 Patch transaction 不迁移到 Node。
7. 文档与知识写入继续经过现有提案、审批、revision 校验和 Rust transaction。

## 3. 基础契约

### 3.1 ID 语义

后续不得继续用同一 ID 同时表示业务任务、模型运行和会话：

| ID                      | 唯一语义                                                   |
| ----------------------- | ---------------------------------------------------------- |
| `work_item_id`          | 一项需要完成和验收的业务工作                               |
| `workflow_id`           | 可跨事件、定时器和人工等待恢复的长期流程                   |
| `run_id`                | 一次有界 Agent 执行；运行结束后不可被新事件原地唤醒        |
| `turn_id`               | 一次 Provider 模型调用                                     |
| `tool_call_id`          | 一次领域工具执行及其审计、取消和结果                       |
| `provider_tool_call_id` | 可选的 Provider 原始 Tool Call ID，用于映射而非替代内部 ID |
| `session_id`            | 对话或认知连续性；不得继续代指 document ID                 |

历史 `AgentTask.id`、`task_runs.id`、UI lifecycle `runId` 和 `sessionId=documentId` 在迁移期保持可读；新契约必须显式映射，不得静默改义。

### 3.2 授权语义

- `executionAuthorization`：工具执行前授权。MCP 只有 `serverTrusted && readOnly` 时才可免逐次确认。
- `mutationApproval`：Patch、Knowledge Candidate 或其他规范数据修改的提交后审批。
- `externalActionApproval`：发送邮件、外部提交、发布等不可逆副作用的执行前审批。

这些语义分别持久化和展示；`requiresConfirmation` 已退出生产工具契约。

### 3.3 Runtime v1

当前可替换 Runtime Port 已提供：

```text
startRun(request)
cancelRun(runId)
steerRun(runId, input)
subscribeEvents(runId)
```

`resumeRun` 不属于 v1 承诺。没有 durable checkpoint 时，Workflow 通过新的 `run_id` 和 `causation_id` 继续，不恢复已经结束的模型循环。

当前 `AgentRunRequest v1` 冻结：

```text
runId / workItemId / workflowId?
objective
contextBundle
executionPolicy
toolManifest
modelPolicy
outputContract
correlationId / causationId
```

Runtime 事件契约覆盖：

```text
run.started / run.progress / run.completed / run.failed / run.cancelled
model.started / model.progress / model.completed / model.failed / model.cancelled
message.started / message.progress / message.completed / message.failed / message.cancelled
tool.started / tool.progress / tool.completed / tool.failed / tool.cancelled
authorization.started / authorization.progress / authorization.completed / authorization.failed / authorization.cancelled
```

事件只保存可审计的决策摘要、输入输出和状态，不保存应用内部隐藏思维链。

### 3.4 累计预算

ExecutionPolicy 后续版本必须在每次模型 turn 和 tool batch 后累计并检查：

- `maxInputTokens`
- `maxOutputTokens`
- `maxTotalTokens`
- `maxCost`
- `maxModelTurns`
- `maxParallelTools`

当前已冻结累计预算协议，但除输出和模型轮次外尚未实现跨 turn 的累计硬限制，不得在文档或 UI 中描述成已经实现的累计成本预算。

## 6. Phase 2：Node + PI 纵向原型（已完成）

### 目标

验证 PI 能否作为可替换 Worker 实现，而不是预先宣布全面迁移。

### 决策结果（2026-07-29）

纵向原型和定向对比已完成，决策门选择 **保留 AI SDK**。PI 已证明可以适配共享 Runtime contracts、Tool Manifest、NDJSON 工具 RPC 和 Patch 提案边界，但真实 Provider/Tauri 代理、授权等待与 structured-output repair 尚未达到现有 AI SDK 的生产证据强度。Phase 3 首次迁出 WebView 时只改变运行位置，不同时更换模型循环。完整证据、缺口与重新开启条件见 [Phase 2 PI Runtime 原型与决策记录](pi-runtime-phase2-decision.md)。

合并后维护已补齐新审批字段的前端审计测试基线，并消除 Mind Map 右键菜单在主点击关闭时的事件竞态；Phase 2 相关定向回归保持通过。

### 原型链路

```text
AgentRunRequest
→ Node PI Worker
→ search_documents
→ read_document
→ 一个只读 MCP Tool
→ submit_document_edits
→ 现有 AgentPatchSet / Diff
→ 现有 Rust transaction
```

### 交付物

- `DomainTool → PiToolAdapter`，Node 通过 RPC 调 Rust 工具且不连接 SQLite。
- Tool schema、Provider/internal call ID、MCP `isError`、progress、并行调用和取消映射。
- reasoning/content、structured output、Context Bundle、usage 和 finish reason 对照记录。
- Worker 崩溃后由 Rust 将对应 Run 标记为 interrupted 的纵向验证。
- AI SDK 与 PI 在同一测试场景下的能力、复杂度和诊断对比。

### 依赖

当前主干已经落地的 Runtime Port 和统一 Tool Manifest。

### 退出条件与决策门

原型通过后，必须形成一份明确决策，只能选择：

1. 保留 AI SDK；
2. 使用 `pi-agent-core`，继续复用现有模型层；
3. 同时采用 `pi-agent-core + pi-ai`。

无论选择哪项，Rust Core、Domain Tool、MCP、Skill、审批和数据库边界保持不变。

本次已选择第 1 项；第 2、3 项不进入 Phase 3 的首次生产迁移。

### 本阶段不做

- 不同时迁移 Ask/Edit/Agent/Research/Review/Learning，不让 PI 直接写 Patch 或数据库。

## 7. Phase 3：Runtime 移出 WebView

### 实施状态（已完成）

默认生产 Runtime 已切换到可运行的 sidecar 纵向链路：

- 共享 contracts 已冻结 Worker v1 envelope，覆盖实例身份、Run、Tool、工具审计、凭据解析、Authorization、heartbeat 和 shutdown。
- `@mynotebook/agent-runtime-worker` 已提供 Node Worker Host、真实 `AiSdkWorkerRuntime` 与 `SidecarRunPlanner`；前端只提交冻结的交互快照，Task、Context Bundle、ExecutionPolicy、Tool Manifest、Cognitive Output Contract 与 AI SDK 模型循环均在 sidecar 生成/执行。Rust 在发送给 sidecar 前枚举 MCP 目录并冻结授权矩阵，WebView 不再管理生产 Runtime 的 MCP 生命周期。
- Rust `AgentWorkerSupervisor` 已提供自包含 Worker 路径解析、stdin/stdout NDJSON、实例校验、heartbeat 超时、受控重启、活动 Run 跟踪、崩溃 `interrupted` 终态、Tauri commands 和窗口重建状态快照。Snapshot 只暴露 Run/work item/session/objective、待授权请求和待领取终态等投影，不泄露 compiled context；新窗口会重建运行/等待视图并继续转发取消或授权。知识中心的后台运行控制面板订阅同一脱敏 snapshot event，显示 heartbeat、重启计数和活动/等待数量。
- 标准 Agent/Create/Plan Run 在 sidecar 内编译 proposal projection，Rust 会在 `run.result` 前原子写入 Patch、来源和任务状态；Vue 仅投影持久化后的结果到既有 Diff 审阅 UI。Cognitive/A2A Run 的 Session、请求结果和 Research candidates 也由 Rust 持久化，窗口恢复只读取投影。
- Rust dispatcher 已接管 Provider 网络与凭据注入、工具审计、全部 25 个内置工具和 MCP 调用：AI SDK 的自定义 `fetch` 通过 NDJSON 把请求交给 Rust `reqwest`，响应分片流回 Worker，取消会终止 Rust future；文档、检索、Mind Map、Skill 读取、本机检查走受控读取；自动化、Skill 和 MCP 资源只创建停用草稿；文档写工具仍由 Worker 捕获为 Patch 提案。Node 不访问 SQLite、MCP 配置或密钥值。
- Node SEA + esbuild 构建可生成按 Tauri target-triple 命名的自包含 sidecar，构建时会执行真实进程协议 smoke；`externalBin` 桌面构建已通过，不要求最终用户安装 Node。
- composition 默认选择 `rust_worker`；只有显式设置 `VITE_AGENT_RUNTIME_OWNER=webview` 才启用兼容路径。Ask/Edit 的 Markdown completion 路径保持不变。
- A2A 队列检查、原子领取、sidecar 启动、审批/拒绝、修订和终态结算均由 Rust watcher/仓储负责；WebView 只订阅变化事件和投影审阅状态，不再启动 A2A Run。

Phase 3 的退出条件已经满足。真实 Provider/Tauri 凭据 smoke 和删除 WebView compatibility path 继续留在后续质量轨道；数据库所有权与升级恢复已经在 Phase 4 完成，不再是 Phase 3 的阻塞项。

Phase 4 的代码与自动化退出条件已完成：migration `0037` 保存无密钥后台 Runtime Profile，`0038` 增加 A2A lease/retry/Dead Letter，`0039` 增加 Durable Timer 与统一等待条件。A2A 自动调度、审批/修订 Workflow、Cognitive 最终业务投影与 Research candidate 落库已迁至 Rust/sidecar；Rust 现为 SQLite 唯一写入者，主窗口关闭后 watcher、timer 与已开始 Run 可继续执行。Windows 全新安装、安装包升级和签名环境仍按 11.1 的发布质量轨道验收，不混同为本阶段已自动化的 schema 升级测试。

### 目标

让 Agent 执行不再由 Vue 生命周期拥有。

### 交付物

- Rust 作为父进程，通过 NDJSON/JSON-RPC over stdio 启动、监督和关闭自包含 Worker；安装包不要求用户安装 Node。
- RPC 覆盖 `runtime.hello`、`run.start/cancel/steer/event`、`tool.invoke/result`、`authorization.request/result`、`heartbeat` 和 `shutdown`。
- `useAgentRun` 缩减为请求提交、事件订阅、授权回复、取消和 UI projection。
- Rust 负责 Worker 实例身份、heartbeat、崩溃检测、重启和未完成 Run 终态。
- 应用重新打开窗口后可从 Rust Core 重建活动/等待任务视图。

### 依赖

Phase 2 完成决策门；Worker 内部可使用最终选择的 adapter。

### 退出条件

- 关闭并重新打开窗口不会丢失 Rust Core 中的任务状态。
- Worker 崩溃不会留下永久 `running` Run，可诊断并受控重启。
- Vue 不再拥有模型循环、工具策略、MCP 生命周期或后台 polling。

### 本阶段不做

- 显式退出整个 Tauri 进程仍会停止后台任务；暂不做系统服务或远程客户端。

## 8. Phase 4：托盘后台与数据库所有权收敛

### 目标

先实现可控的托盘常驻，再考虑真正的 headless daemon。

### 交付物

- 关闭窗口默认隐藏到托盘；显式“退出应用”才停止 Rust Core 和 Worker。
- Worker lease、启动恢复扫描、heartbeat、指数退避、Dead Letter、Durable Timer 和等待条件。
- 将全部 WebView repository 写操作迁移为 Rust 固定 mutation command，并以架构测试禁止回归。
- 移除 `plugin-sql` 和主窗口全部 SQL capability；读取通过 Rust 管理的只读 SQLx pool 返回序列化结果。
- 为生产资源配置非空 CSP，并按实际 UI/模型连接需要最小化 fs/opener/network 能力。

### 实施状态（代码与自动化验收已完成）

- 托盘常驻、主窗口关闭转隐藏、托盘重新打开/显式退出已完成。
- A2A 自动调度、审批/拒绝、修订 continuation、无窗口终态结算已完成；批准仍复用既有 Rust Patch revision/覆盖/事务校验。
- Cognitive Session 终态和 Research candidate/source/validation 已由 Rust 持久化；candidate 使用稳定 projection ID，并与 Cognitive Session、AgentTask、A2A result 在同一个事务提交。Review/Learning 结构化结果随 A2A result 保存。
- A2A 请求已使用持久 lease 原子领取和 `run_id` fencing；Worker 事件续租，迟到旧 Run 不能结算新尝试，显式可重试错误按指数退避最多尝试三次，随后进入可诊断 Dead Letter。启动扫描会保留 Supervisor 仍持有的 Run，并回收、重排无活动所有者的 `running` 请求；旧 task/session 会写入中断/取消终态。软件 MCP 的 `get_agent_request` 返回尝试、重试和死信元数据。
- 前端已将上述可靠性字段纳入版本化请求模型和只读列表查询；任务验收页按队列事件刷新最近 A2A 请求，展示 `run_id`、尝试次数、下次重试、失败类型和死信时间，但不暴露 `lease_owner`，也不提供绕过 Rust 状态机的重试或结算按钮。
- P4.5 过渡加固已完成：migration `0040` 冻结 Event Envelope v1 与 Outbox Dead Letter 字段，`0041` 恢复表重建后的 Outbox processing lease 索引；A2A/Timer/Outbox 复用显式可靠性策略；Timer 健康快照和跨 Workflow/Timer/Event/Outbox correlation 审计已进入 UI。Timer schedule/cancel 和 Outbox claim/settle 不再暴露给 WebView。
- 已发布 SQL migration 通过 LF 属性和 checksum 架构测试保持字节不可变；实际版本 35 用户数据库已完成 35→41 升级、完整性与外键验证，修复 Windows CRLF 导致的 migration 29 checksum mismatch。
- migration `0039` 增加 timer/event/human/approval 等待条件与 Durable Timer。Timer 使用绝对 UTC 到期时间、原子 lease、去重键、指数退避和 Dead Letter；触发时在同一事务写 Domain Event/Outbox 并满足等待条件。`0038 -> 0039` 数据保留升级、数据库关闭/重开、过期 lease、休眠或墙钟跳变、取消竞争与重复领取均有自动化测试。
- WebView 的存量 repository mutation 已迁到 Rust 封闭 catalog；生产 TypeScript 中不存在 SQLite `.execute()`，`plugin-sql` 及其 Tauri/JS 依赖、预载配置和 SQL capability 已删除。读取命令只接受单条 `SELECT/WITH`，并使用 `read_only + query_only` 的独立 SQLx pool。
- 生产 CSP 已非空，Provider 网络继续只由 Rust 代理；文本文件只在系统文件对话框动态授权后读写，外部 URL 仅允许 HTTP(S)，附件与 Skills 本地路径由 Rust 校验后打开，WebView 不再拥有静态文件范围或本地 path opener。
- 自定义数据目录迁移会先阻止新 Run，暂停并等待 watcher/timer/钉钉 connector，拒绝活动 Run，关闭空闲 sidecar 与全部 pool；成功后绑定目标目录，失败时恢复原目录，避免后台任务在复制期间重开旧数据库。
- 上述恢复以一次完整 Run 为粒度，不提供模型 tool step checkpoint。A2A lease 防止并发重复领取；异常退出后的孤儿请求按 at-least-once 语义创建新 Run 并有界重试，因此模型调用和尚未进入受控事务/Outbox 的外部副作用不宣称 exactly-once。跨 Run 的外部动作幂等与 fencing 属于 Phase 5 Action Gateway。

### 依赖

Phase 3 进程监督稳定。

### 退出条件

- 窗口隐藏时人工请求、定时器和已开始的 Run 可继续。
- 数据库 schema 升级、休眠和时区变化后，Timer 不重复提交同一 Domain Event/Outbox；A2A 请求不被并发领取，异常退出后的重放具有 attempt、退避和 Dead Letter 审计。
- Rust 成为 SQLite 唯一写入者，WebView 无 SQL execute 权限。

### 本阶段不做

- 不注册 Windows Service，不开放远程 Core API。

## 9. Phase 5：事件驱动 Workflow

### 实施状态（已完成）

- migration `0046` 已建立统一 `workflow_work_items`、`workflow_instances` 和 `workflow_run_attempts`。人工、计划 Timer、RSS 与相关更新事件先去重和分类，再进入 Work Item/Workflow；自动化与信号 Agent 的 Runtime request 使用真实 `work_item_id/workflow_id/correlation_id/causation_id`。
- `SuspendRequestV1` 与 Rust 等待续接覆盖 Event、Timer、Human、Approval 和 retry。挂起会结束当前 Run；Timer 或 correlation 匹配事件满足等待后把 Workflow 推进到 `READY`，续接必须创建新的 `run_id`，不使用 `resumeRun`。
- RSS 自动化继续在 Rust 中同步、canonical 去重和冻结增量内容；重复来源事件不会重复创建 Work Item。每次失败 attempt 有界重试，旧 Run 的迟到终态不能越过当前 run fencing。
- Rust Action Gateway 已持有 `externalActionApproval`、动作级幂等键、持久 lease、单调 fencing token、attempt、重试、Dead Letter 和 Outbox 事件。未审批动作不可领取，迟到旧 worker 不能结算新 attempt；窗口或 Worker 重启不会丢失审批与等待状态。
- 当前没有启用真实外部动作 handler，符合本阶段“不发送邮件、不扩大钉钉权限”的边界。后续邮件、IM、发布或外部日历只能作为 Rust allowlist dispatcher 接入 Action Gateway。

完整事实与恢复语义见 [事件驱动 Workflow 与 Action Gateway](event-driven-workflows.md)。

### 目标

把长期等待和确定性编排放在 Rust Workflow，而不是让一个 Agent Run 长时间阻塞。

### 事件链路

```text
Event
→ Trigger Match
→ Signal
→ Work Item
→ Workflow
→ Agent Run / Deterministic Action
```

统一事件至少包含 event/source/time/actor/workspace/correlation/causation/deduplication/payload/security scope。

等待状态统一为：

```text
WAITING_EVENT
WAITING_TIMER
WAITING_HUMAN
WAITING_APPROVAL
RETRY_SCHEDULED
```

Agent 遇到长期等待时返回终态 `SuspendRequest`，当前 Run 随即结束；Workflow 保存等待条件。新事件到达后创建新的 `run_id`，不能原地唤醒已结束的模型循环。

### 交付物

- 首批来源覆盖人工请求、定时任务、RSS 和相关更新事件；后者冻结邮件/RSS/IM/会议上下文后由 Agent 自主决策。
- 每个来源先去重、分类和创建 Work Item，再决定是否需要 Agent；不得“每条事件启动一个 Agent”。
- 外部动作统一经过 Action Gateway、`externalActionApproval` 和 Outbox。
- 人工授权、知识 Mutation 和外部动作等待都可跨窗口/Worker 重启恢复。

### 依赖

Phase 4 的 durable timer、lease、outbox 和托盘运行稳定。

P4.5 的 envelope 脚手架已经收敛为上述生产 Workflow 与 Action Gateway 边界。首页信号 Agent 可检索知识并通过专用工具幂等更新本地待办/日历，不是固定分类 flow；这些本地动作不绕过知识 Mutation 或真实外部动作审批。

### 退出条件

- 人工请求、Timer 和 RSS 各完成一条可恢复 Workflow。
- 重复事件不会创建重复 Work Item 或重复副作用。
- 扩展更多 IM 来源和外部动作前，等待、重试、审批和恢复均有可重复验收。

### 本阶段不做

- 不发送邮件，不扩大钉钉读取权限，不接云 Relay。

## 10. Phase 6：Headless Core

### 实施状态（进行中）

- 已建立独立无 Tauri Headless Core 进程入口。Desktop 可发现或拉起 Core，但不会因窗口关闭或 Desktop 退出主动终止 Core。
- v1 控制面只监听随机 `127.0.0.1` 端口，使用每实例 CSPRNG 凭证、磁盘 endpoint 身份、健康检查和 major/minor 协商；凭证不进入 WebView snapshot。
- 数据库 prepare、WebView 只读 query、封闭 mutation catalog 与 read-pool close 已经通过协议 `1.1` 进入 Core；数据目录迁移会先关闭 Core 和 Desktop 两侧相关 pool。其他 Rust 领域模块暂时仍直接使用 Desktop pool。
- 协议 `1.2` 已把 Durable Timer 的调度循环、lease/retry/Dead Letter、触发事务和健康快照迁入 Core。Desktop 只代理快照并投影 `workflow-timer://status`；数据目录迁移通过 Core 的 quiesce/resume 路由切换计时器所有权。
- 协议 `1.3` 已把 correlation Event 等待匹配与已满足等待续接扫描迁入 Core，并把数据目录迁移收敛为统一 Core background runtime quiesce/resume；Desktop A2A watcher 不再并发扫描 Workflow 等待。
- 当前已完成控制进程、WebView 数据库 catalog、Durable Timer 与 Workflow 等待续接扫描迁移；Outbox publisher、Workflow Run 调度、Automation/Signal、Connector、Action 和 Worker Supervisor 尚未迁入 Core，因此本阶段尚未达到退出条件，也不宣称已经实现进程级 SQLite 唯一所有权。

实现事实、威胁边界与迁移顺序见 [Headless Core 进程与本地协议](headless-core.md)。

### 目标

只有托盘模式和 Workflow 稳定后，才把 Core 从桌面进程生命周期中进一步拆出。

### 交付物

```text
MyNoteBook Desktop  # UI Client
MyNoteBook Core     # Rust Daemon：DB/Event/Workflow/Connector/Action
Agent Worker        # 可替换 Runtime 实现
```

- 本地通信从父子进程 stdio 演进为 Windows Named Pipe，或带随机实例凭证的 localhost HTTP/WebSocket。
- Desktop 可关闭，Core 继续运行；重新打开后重新订阅 Work Item、Workflow 和 Run。
- Worker 可独立崩溃重启，不能拥有系统事实或审批状态。

### 依赖

Phase 4 和 Phase 5 已通过长时间运行、升级与恢复验收。

### 退出条件

- Desktop、Core、Worker 可独立升级/重启且不会破坏数据库单一所有权。
- 本地身份、版本协商、并发写入和恢复协议明确。

### 本阶段不做

- 不直接开放互联网端口，不把 Web/移动端连接或多设备同步纳入本阶段交付。

### 后续决策门

只有此阶段稳定后，才评估 Web/移动端作为 Core 客户端；它们不进入近期承诺。

## 11. 并行质量与产品轨道

以下工作不应等待全部 Runtime 阶段完成，但必须遵守新的 contracts 和安全边界。

### 11.1 真实 Provider 与发布验收

- 完成 Research、Learning 的真实 Provider/Tauri smoke，以及取消、超时、结构化输出、来源复验和应用重启诊断。
- 验证 Windows 全新安装、升级、自定义数据目录迁移、备份恢复和卸载数据策略。
- Node Worker 进入安装包后，增加无系统 Node 环境、签名、杀毒软件、升级回退和 Worker 版本协商验收。

### 11.2 结构化工作区 Agent 能力

- 新工具必须进入统一 Domain Tool Manifest，先提供 canonical read，再提供 revision/Diff/审批式修改。
- Slidev `nbId`、UML 节点/边 ID、Table 行列 ID 必须具备稳定锚点和并发冲突测试。
- 不允许结构化 View 成为第二写入口。

### 11.3 Dashboard 与信息首页

- 继续完成 WebView2 高 DPI、拖拽和键盘替代操作验收。
- Widget 继续只消费查询和受控 command，不直接拥有 Workflow 或数据库写权限。
- 新 Signal 模块必须显示来源时间、权限状态和 canonical 记录跳转。

### 11.4 外部集成

- 保留现有 IMAP、RSS、钉钉只读采集能力；在 Phase 5 前不叠加无人值守 Agent 编排。
- 邮件发送、IM 回复、外部日历和网页裁剪必须在 Action Gateway、审批和恢复协议稳定后接入。

## 12. 暂不进入近期范围

- Node 或 PI 直接访问 SQLite、密钥文件、MCP 配置或 canonical 文档事务。
- 同一 Run 同时运行 AI SDK 与 PI 两套模型循环。
- 一次迁移 Ask、Edit、Agent、Research、Review 和 Learning。
- 用 PI Session、LangGraph 或任意 Agent SDK 代替 Workflow、事实源或审批状态。
- 每封邮件、每条 RSS 或每条 IM 都无条件启动 Agent。
- 向量数据库、自动长期记忆、云同步、多人实时协作或自治多 Agent 市场。
- 任意代码插件、任意 shell、未授权网络抓取和模型直接写正式知识。

## 13. 路线图维护规则

- 路线图只保留未完成事项；完成后把事实移入对应专题文档并从阶段中删除。
- 每项能力必须同时说明所有者、事实源、权限、失败恢复和退出条件。
- 不记录易失真的临时测试总数、请求 ID、日历承诺或调试过程。
- 当前实现与目标实现必须使用明确标签，不能把原型、sidecar、托盘、PI 或 daemon 写成现有能力。
- 若代码、migration、定向测试与文档冲突，以可重复事实为准，并立即修正文档。
