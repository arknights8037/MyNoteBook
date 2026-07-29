# 后续开发路线图

本文是 MyNoteBook 未完成工程工作的权威排序，已按 2026-07-29 主干代码与 migration `0001`–`0036` 复核。当前架构事实见 [系统架构](architecture.md)，生产 Agent 行为见 [Agent Runtime](agent-runtime.md)，PI 评审输入见 [PI 接入资料](pi-integration-high-value.md)。

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

当前真正限制异步任务、自动化和外部事件发展的不是 Agent 工具不足，而是：

> Agent Runtime、业务编排、授权等待和 A2A 轮询仍运行在 Vue/WebView 生命周期中。

`useAgentRun.ts` 目前已通过 Runtime Client/Port 驱动 AI SDK Adapter，但仍连接 UI 状态、模式分发、Context、MCP、Skill、授权和终态持久化；A2A worker 使用 Vue `setInterval`。窗口/应用退出后普通 Agent Run 不能继续，也不能从 tool step checkpoint 恢复。后续不得继续围绕这条前端热路径叠加邮件、IM、定时器或长期 Workflow。

## 2. 当前边界与目标边界

### 2.1 当前事实

```text
Vue / WebView
├── Ask / Edit / Agent / Auto 分发
├── AgentRuntimeClient / Runtime Port
├── AiSdkAgentRuntimeAdapter -> AI SDK ToolLoopAgent
├── Context / Tool / Skill / MCP 编译
├── Agent 生命周期、授权等待与 A2A polling
└── TypeScript repositories ─────┐
                                  ├── SQLite editor.db
Tauri / Rust                     │
├── migration / WAL / backup ────┘
├── canonical document transaction
├── MCP / Skill / Secret / Connector
└── 原生工具、取消与模型 HTTP 代理
```

当前 Rust SQLx 与 WebView `plugin-sql` 都会访问 SQLite，因此 Rust 尚不是严格的单一数据库进程所有者。`tauri.conf.json` 也尚未配置 Node sidecar、托盘或 daemon。

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

1. Rust Core 逐步成为 SQLite、连接器、凭据、Workflow 状态和副作用的唯一所有者。
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

## 6. Phase 2：Node + PI 纵向原型

### 目标

验证 PI 能否作为可替换 Worker 实现，而不是预先宣布全面迁移。

### 决策结果（2026-07-29）

纵向原型和定向对比已完成，决策门选择 **保留 AI SDK**。PI 已证明可以适配共享 Runtime contracts、Tool Manifest、NDJSON 工具 RPC 和 Patch 提案边界，但真实 Provider/Tauri 代理、授权等待与 structured-output repair 尚未达到现有 AI SDK 的生产证据强度。Phase 3 首次迁出 WebView 时只改变运行位置，不同时更换模型循环。完整证据、缺口与重新开启条件见 [Phase 2 PI Runtime 原型与决策记录](pi-runtime-phase2-decision.md)。

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

- 关闭整个 Tauri 进程仍会退出；暂不做系统服务或远程客户端。

## 8. Phase 4：托盘后台与数据库所有权收敛

### 目标

先实现可控的托盘常驻，再考虑真正的 headless daemon。

### 交付物

- 关闭窗口默认隐藏到托盘；显式“退出应用”才停止 Rust Core 和 Worker。
- Worker lease、启动恢复扫描、heartbeat、指数退避、Dead Letter、Durable Timer 和等待条件。
- 逐步将 WebView repository 写操作迁移为 Rust command；迁移期间禁止新增直接写路径。
- 写路径迁移完成后撤销主窗口 SQL execute 权限；只读查询是否保留由后续审计决定。
- 为生产资源配置非空 CSP，并按实际 UI/模型连接需要最小化 fs/opener/network 能力。

### 依赖

Phase 3 进程监督稳定。

### 退出条件

- 窗口隐藏时人工请求、定时器和已开始的 Run 可继续。
- 应用升级、休眠、时区变化和异常退出后不会重复领取同一任务。
- Rust 成为 SQLite 唯一写入者，WebView 无 SQL execute 权限。

### 本阶段不做

- 不注册 Windows Service，不开放远程 Core API。

## 9. Phase 5：事件驱动 Workflow

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

- 首批来源只覆盖人工请求、定时任务和 RSS。
- 每个来源先去重、分类和创建 Work Item，再决定是否需要 Agent；不得“每条事件启动一个 Agent”。
- 外部动作统一经过 Action Gateway、`externalActionApproval` 和 Outbox。
- 人工授权、知识 Mutation 和外部动作等待都可跨窗口/Worker 重启恢复。

### 依赖

Phase 4 的 durable timer、lease、outbox 和托盘运行稳定。

### 退出条件

- 人工请求、Timer 和 RSS 各完成一条可恢复 Workflow。
- 重复事件不会创建重复 Work Item 或重复副作用。
- 邮件与 IM 接入前，等待、重试、审批和恢复均有可重复验收。

### 本阶段不做

- 不发送邮件，不扩大钉钉读取权限，不接云 Relay。

## 10. Phase 6：Headless Core

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
