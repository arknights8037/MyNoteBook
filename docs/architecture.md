# 当前架构与模块边界

本文是 MyNoteBook 当前架构的事实入口。它描述已经存在的实现、代码所有权和必须保持的依赖方向；认知系统契约与后续设计见 [认知系统集成设计](cognitive-system-integration.md)，未完成事项见 [后续开发路线图](roadmap.md)。

## 1. 产品与技术边界

MyNoteBook 是 Vue 3 + Tiptap 前端、Tauri/Rust 桌面壳和 SQLite 本地存储组成的单机应用，不是 React 应用，也不是由多个服务组成的分布式系统。

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
| Cognition     | 版本化 Mode/Template、CognitiveRunSpec、Output Contract、Session 和知识候选控制          |

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
  -> Context Bundle + ExecutionPolicy
  -> AI SDK ToolLoopAgent
  -> 内置 Tools / MCP / Skills
  -> 结构化 command 或 Patch
  -> Diff 与用户确认
  -> Rust Agent transaction
  -> Document Core 校验与写入
```

模型流式输出、工具结果和 MCP 返回值都不能直接成为文档写入。完整协议见 [Agent Runtime](agent-runtime.md)。

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
- `database.rs`：数据库路径、连接池、迁移、旧库基线和可靠性设置。
- `document_core.rs`：可信文档校验、投影生成、持久化和修复。
- `agent_repository.rs`：Agent task、Context Bundle、Patch、事务与审计持久化。
- `agent_tools.rs`：数据库工具、只读命令和 Rust 线性时间正则执行。
- `agent_cancellation.rs`：按 tool call ID 取消正在运行的原生或 MCP future。
- `work.rs`：TaskRun、Verifier、ChangeSet 和 Approval 的原子状态变更。
- `views.rs`：View snapshot/dependency 发布及 override 保护。
- `governance.rs` / `domain_events.rs`：Delegation、外部提交、幂等、Event 和 Outbox。
- `mcp.rs`：MCP Client Tools/Resources 及 transport 生命周期。
- `skills.rs`：Skill 目录、启停、受限文件访问和版本信息。
- `secret_store.rs`：API Key 的 AES-256-GCM 密文与系统凭据库数据密钥。
- `bin/mynotebook-mcp.rs`：SQLite query-only 的独立只读 MCP Resource Server。

Rust command 应立即委托给对应模块。数据库访问必须复用 `database.rs` 管理的路径、迁移和连接设置。

## 4. 前端模块所有权

- `src/app/composition`：唯一允许组装具体 Tauri/SQLite adapter 与应用服务的位置。
- `src/pages`：薄入口，只选择 provider、注入依赖和转发公开事件。
- `src/features`：面向用户的完整功能面及其局部状态。
- `src/composables`：Vue 生命周期和跨组件响应式工作流。
- `src/services`：应用用例与框架无关的领域编排。
- `src/repositories`：持久化端口；`src/infrastructure` 提供 Tauri/SQLite 实现。
- `src/models`：领域类型、版本化协议、默认值和纯校验。
- `src/editor`：Tiptap/ProseMirror 集成和编辑器纯算法。
- `src/ui`：不包含产品工作流的通用展示原语。

依赖方向为：composition → feature/page → composable/service → repository/model。`models` 不依赖 Vue、service 或 Tauri；可复用 service 不应直接选择基础设施实现。

## 5. 当前公共能力

### Agent 与 AI

- OpenAI、Anthropic、DeepSeek、Qwen 和 OpenAI-compatible Provider。
- Ask、Edit、Agent 及 `/plan`、`/create`、`/interactive`、`/research`、`/review` 等入口。
- AI SDK 原生多轮工具循环、结构化 command/Patch、工具进度、取消和失败审计。
- 版本化 Context Bundle、ExecutionPolicy、Provider 实际参数与 Skill provenance。
- 当前文档/选区/大纲、FTS5 检索、跨文档读取、来源 block 跳转。
- Patch/Diff、逐项确认、revision 冲突保护和安全撤销。
- 代码内版本化 Cognitive Mode/Template Registry、Tool Tag → 工具名权限编译和可插拔 Output Contract。
- 持久化 Cognitive Session，以及带正文、结构化数据、provenance、多来源和 Validation 的 Knowledge Candidate。

### Knowledge、Work、View 与治理

- Rule、Decision、Goal、Task、Evidence、ChangeSet Knowledge Object 及关系。
- TaskDefinition/TaskRun、Artifact/Evidence、Result Verifier、ChangeSet/Approval。
- Query/Projection/Generated View、依赖快照、stale、manual override 和显式分叉。
- MCP Tools/Resources Client、只读 MCP Server、CLI Delegation 和外部提交。
- Domain Event、Transactional Outbox、lease/retry 和统一审计读取。

## 6. 必须保持的安全不变量

1. 模型和外部工具不能直接更新规范文档或正式知识。
2. 文档修改必须经过 command/Patch、本地验证、用户确认和 Rust transaction。
3. 工具执行前必须先写 `running` 审计；审计失败时不执行工具。
4. MCP Server 本地信任和工具 `readOnlyHint` 必须同时满足才可免逐次确认。
5. Context Bundle、来源 revision、ExecutionPolicy 和 Provider 参数必须可追溯。
6. View、Artifact、模型回复和外部 Result 都不是事实来源。
7. 已发布 migration 不修改；Schema 变化只能增加新 migration。

## 7. 已知偏差与近期修正

- `AgentCommandService` 的安全正则执行器已改为由 `src/app/composition` 注入，service 不再选择 Tauri adapter。
- 现有 `/research` 和 `/review` 仍是 Slash intent + Prompt 策略，尚未绑定已实现的 Cognitive Mode、Session 和 Output Contract；这属于 C2/C3，而不是第二套 Runtime。
- Runtime 已支持可插拔 `AgentOutputContract<T>`，旧 command/Patch 协议保持默认；当前只接入代码级测试认知 contract，尚无 Cognitive Result UI。
- Tool Tags 已在运行前编译成 `ExecutionPolicy.allowedTools`，Runtime 热路径仍只检查稳定工具名；Mode/Template/Skill 不能扩大基础策略。
- Knowledge Object 已扩展研究候选所需类型、正文、结构化数据、认知 provenance、多来源、Validation 和 rejected 状态；候选 UI 与来源失效处理属于后续闭环。
- Agent tool trace 尚未绑定并持久化到每条聊天消息；切换历史不能恢复完整 loop。
- P1/P2 自动化测试及 G0 smoke 已覆盖真实 Windows 数据副本升级、真实 Provider、stdio/Streamable HTTP MCP、真实 CLI 与隔离故障恢复边界。

这些偏差的处理顺序以 [后续开发路线图](roadmap.md) 为准。
