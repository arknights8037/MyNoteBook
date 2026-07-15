# 后续开发路线图

本文只维护尚未完成的工作。已完成实现以 [当前架构](architecture.md)、[Agent Runtime](agent-runtime.md) 和代码测试为准，历史过程通过 Git 追溯。

## 总体策略

```text
G0 现有架构稳定性门禁
  -> C1 最小认知内核
  -> C2 Research 完整闭环
  -> C3 Review
  -> C4 Learning
```

不先建设通用工作流引擎，也不同时开发三个认知模式。每个阶段只有在前一阶段验收通过后进入下一阶段。

## G0：现有架构稳定性门禁

### 工作

- 在 Windows 桌面应用中使用真实或复制的数据目录验证 migration 0009–0014、备份、失败恢复和自定义数据目录迁移。
- 验证文档保存/投影修复、Agent Patch/Diff/接受/撤销、工具取消和应用重启恢复。
- 使用至少一个真实 Provider 验证 Agent tool loop、结构化终态、错误与取消。
- 验证 Knowledge Object、TaskRun、Artifact/Evidence、Verifier、ChangeSet/Approval 和 Generated View override。
- 验证 stdio/Streamable HTTP MCP Tools/Resources、只读 MCP Server、CLI Delegation、幂等外部提交与 Outbox lease 恢复。
- 把 `AgentCommandService` 的安全正则执行改成注入 `RegexReplaceExecutor`，具体 Tauri 实现在 composition 选择。
- 补齐发布前 `v-html` 内容净化/XSS 复核，以及工具结果、代理错误体和第三方日志的敏感信息回归。

### 验收

- 形成可重复的 Windows smoke 清单和结果记录。
- 不存在阻断认知系统的 P0/P1 数据一致性、权限或取消缺陷。
- 前端全量测试、类型检查、lint、生产构建和 Rust 全量测试通过。
- 架构依赖检查确认可复用 service 不直接选择 Tauri/SQLite adapter。

### 2026-07-15 执行记录

状态：**完成（2026-07-15）**。代码、本地数据、真实 Provider、Streamable HTTP MCP、真实 CLI 外部进程与隔离恢复 smoke 均已通过。C1 的代码与自动化验收也已完成；本轮不进入 C2。

已满足：

- 当前 Windows 数据库只读检查通过：migration 1–13 均成功，`PRAGMA quick_check=ok`，`PRAGMA foreign_key_check` 无错误。真实库包含 20 个 TaskRun、12 个 ChangeSet 和 1 个 Approval，Knowledge Control 桌面界面可读取对应控制面。
- 使用现有 Windows 数据库备份的临时副本完成 v2 → v14 升级；升级前快照已生成，文档数量保持不变，升级后完整性与外键检查通过。可用下述 `MYNOTEBOOK_SMOKE_SOURCE_DB` 命令重复，但测试只操作临时副本，不修改来源库。
- migration 新库/v8/v9/v11、升级前 SQLite snapshot、自定义数据目录受管文件迁移、元数据重写和激活失败回滚均有 Rust 回归。
- 文档保存/投影、Patch/Diff/接受/恢复/安全撤销、工具取消与等待授权取消均有前端或 Rust 回归。
- Knowledge Object、TaskRun、Artifact/Evidence、Verifier、ChangeSet/Approval、Generated View override、stdio MCP Tools/Resources、Delegation 幂等和 Outbox lease 过期重领均有回归。
- 当前 release 可执行文件在 Windows 上成功启动并读取原数据目录；文档树、Agent Work、Knowledge Control、审计和设置入口可访问，没有启动或迁移错误。
- `AgentCommandService` 不再选择 Tauri 实现；`RegexReplaceExecutor` 由 `src/app/composition` 注入，缺少注入时拒绝执行。
- `v-html` 的唯一 AI 消息入口由 allowlist Markdown renderer 生成；脚本、SVG/图片事件处理器、`javascript:` 和 `data:` URL 有 XSS 回归。
- 工具参数/结果、Agent/Provider 错误体和 Tauri 第三方日志在持久化、展示或发回模型前统一脱敏；API key、Bearer、capability token、cookie、密码和 URL 凭据有前后端回归。
- G0 修复阶段未提前增加 Cognitive Mode 或 Research 功能；随后根据用户明确指令实施了下述 C1 内核，仍未绑定 `/research` 或增加 Research UI。
- 使用已配置的真实 DeepSeek Provider 和固定非敏感隔离上下文完成工具调用、observation 回传、结构化终态、真实认证错误与运行中取消；未发送现有知识库正文。真实 smoke 发现 Provider SDK 会把 abort 包装为普通 `Error`，Runtime 现统一规范化为 `AbortError` 并有回归。
- 使用本地真实 `rmcp` Streamable HTTP Server 完成握手、HTTP header、Tools 发现/调用、Resources 发现/读取和运行中取消。
- 使用真实 Node CLI 子进程读取冻结 Task/Context Bundle envelope，提交 Result、ChangeSet、Artifact 和 Evidence；幂等重放、Verifier、Approval、Domain Event 和 Outbox 全链路通过。
- 在隔离 v14 数据目录创建 Knowledge Object、Source、Validation 和 Generated View，验证 refresh、manual override 保护、preview、不覆盖当前 snapshot、关闭连接后重开恢复及外键完整性。

本轮修复的 G0 缺陷：

- 数据库升级失败过去只保留备份但不恢复当前库；现在会关闭连接、清理 WAL sidecar，并从升级前 SQLite snapshot 恢复，故障注入测试确认原数据可读且部分 migration 不残留。
- Outbox lease 恢复没有测试；现在确认过期 lease 可被新 worker 重领、attempt 递增、有效 lease 不可抢占、错误 worker 不可 settle。
- 安全正则执行仍由可复用 service 默认选择 Rust/Tauri adapter；默认实现已删除并移到 composition。
- Provider 错误体、工具 observation/audit 和日志缺少统一凭据脱敏；现已增加共享脱敏边界和回归。

可重复 Windows smoke：

```powershell
$env:MYNOTEBOOK_SMOKE_SOURCE_DB='<只读来源数据库或备份的绝对路径>'
cargo test database::tests::windows_copied_database_smoke --manifest-path src-tauri/Cargo.toml -- --ignored --exact
pnpm test:run
pnpm typecheck
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --release --manifest-path src-tauri/Cargo.toml --bin my-notebook
```

桌面复核步骤：启动当前构建的 `src-tauri/target/release/my-notebook.exe`，确认原文档树、Agent Work、Knowledge Control、审计和设置可读取。外部 Provider 仅使用固定非敏感 smoke 上下文；MCP、CLI 和 Knowledge/View 恢复均使用本地 fixture 或隔离临时数据目录。

剩余阻塞：**无 G0 阻塞**。Windows UI 自动化层仍可能把 Tauri 窗口边界报告为 `15×15`，但应用窗口可正常显示；该工具兼容问题不影响应用运行、键鼠使用或上述 Runtime/数据库纵向验收。

## C1：最小认知内核

状态：**完成（2026-07-15）**。G0 与 C1 验收均通过；本轮不进入 C2。

### 工作

- 增加 Cognitive Mode、Knowledge Control Template、CognitiveRunSpec 和代码内版本化 Registry。
- 增加 `AgentOutputContract<T>`，让现有 Runtime 在 command/Patch 之外校验认知 JSON Schema，同时保留旧协议。
- 为内置/MCP 工具增加 tags，并在运行前编译为现有 `ExecutionPolicy.allowedTools`；tags 不进入工具执行热路径。
- 在现有 Prompt 编译流程加入 Mode/Template/Output Contract 分层，执行只收紧权限的合并规则。
- 增加 Cognitive Session repository/service 和迁移，支持 active/waiting_user/completed/cancelled。
- 扩展 Knowledge Object 类型、正文、结构化数据、认知 provenance、rejected 状态、多来源和 Knowledge Validation。
- 为旧 Knowledge Object 提供无损迁移默认值，不修改已发布 migration。

### 验收

- 同一 Runtime 可分别运行旧 command/Patch contract 和新的测试认知 contract。
- 不同 Mode/Template 产生可预测的 Prompt、ContextPolicy、Tool allowlist 和输出 schema。
- Mode、Skill、Template 不能扩大基础 ExecutionPolicy 权限。
- Cognitive Session 可持久化、等待用户并恢复；candidate 状态迁移受 expected version 保护。
- 旧 Agent、Knowledge Control、Verifier、View 和 MCP 流程回归通过。

### 2026-07-15 实现与验证

- 增加代码内版本化 Learning/Research/Review Mode、默认 Knowledge Control Template、`CognitiveRunSpec` 和 Registry；尚未把 Slash Command 绑定到认知流程。
- 增加 `AgentOutputContract<T>` 和 `cognitive-test` v1 contract。同一 `ToolLoopAgent` 已分别通过旧 command/Patch 回归和认知 JSON contract 测试；兼容 fallback 同样执行本地 contract 校验。
- 为 21 个内置工具和 MCP Runtime Tool 增加 tags；编译器在运行前解析为工具名并与基础 `allowedTools` 取交集，denied tags 优先，Runtime 热路径保持按名称校验。
- 增加固定 Prompt 分层编译：基础安全 → Skill → Mode → Template → Task → Context → Output Contract，并有确定性顺序测试。
- 增加 Cognitive Session repository/service、composition factory 和 migration `0014`，支持 active ↔ waiting_user、completed、cancelled、持久化 state 和 expected-version 冲突保护。
- 扩展 Knowledge Object 类型、正文、结构化数据、generated run、mode/template provenance 和 rejected 状态；增加多 SourceRef 与 Knowledge Validation repository。
- candidate 接受/拒绝和通用状态迁移受 expected version 与状态机保护。migration 测试确认旧对象、relation、Task source、View dependency 和单来源锚点无损保留。
- Windows 真实备份副本已重复完成 v2 → v14 迁移，文档数量、完整性和外键检查通过。
- 前端全量回归包含旧 Agent、Knowledge Control、Verifier、View、MCP、Cognitive compiler/contract/session/knowledge。

最终验证结果：

- `pnpm test:run`：104 个测试文件通过、2 个跳过；373 项通过、5 项跳过（其中 3 项真实 Provider smoke 已通过下述显式运行）。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过，0 warning。
- `pnpm build`：通过；保留既有 chunk size 与动态/静态 import 构建提示，无构建失败。
- `cargo test --manifest-path src-tauri/Cargo.toml`：49 项通过、3 项显式忽略（系统凭据诊断、真实 Provider smoke、需指定真实副本的 Windows smoke）。
- 显式运行真实 Provider smoke：DeepSeek 工具循环、结构化终态、认证错误脱敏和运行中取消 3 项通过。
- `cargo build --release --manifest-path src-tauri/Cargo.toml --bin my-notebook`：通过；当前 release 可执行文件已启动并读取 v14 原数据目录。
- 指定 `MYNOTEBOOK_SMOKE_SOURCE_DB` 单独运行 Windows copied-database smoke：通过。
- `git diff --check`：通过；仅显示仓库既有的 LF → CRLF 工作树提示。

## C2：Research 完整闭环

### 工作

- 将 `/research` 绑定 Research Mode、研究结论模板和结构化输出 contract。
- 支持 Claim、Evidence、Assumption、Inference、Limitation、Conflict、Question 和关系提案。
- 将 document/block/revision 来源和验证结果映射为 Knowledge Candidate。
- 在当前 Agent assistant 消息中展示结构化 Research 结果和未解决问题。
- 支持逐项接受、编辑后接受、拒绝、保留、来源跳转和验证详情。
- 接受后写为 `approved` Knowledge Object；Research 不自动生成 active Rule/Decision，不修改原文。
- 来源 revision 失效时标记需要重新验证并阻止直接接受。

### 验收

- Claim 与 Evidence 不混淆，Evidence 必须指向可定位来源。
- 无来源内容明确显示为未验证 claim/question。
- 用户未确认时不存在正式知识写入。
- 修改后接受会增加 candidate version 并保留原始 run/mode/template provenance。
- 完成 `/research` → 工具循环 → 结构化结果 → 来源定位 → 候选确认的 Tauri 纵向 smoke。

## C3：Review

### 工作

- 增加 unsupported claim、missing source、logical gap、conflict、undefined term、missing scope/assumption、outdated information、evidence mismatch 和 ambiguity 类型。
- 复用 Research 的 SourceRef、Validation、Conflict、Candidate 和结果面板。
- Review 默认只读；用户选择处理问题时才转换为现有 Patch 提案。
- 增加 `/find-assumptions`、`/find-conflicts`、`/extract-claims` 等薄命令绑定，不在命令中复制规则。

### 验收

- 每个 issue 尽量携带 document/block/revision、严重程度、说明和建议动作。
- Review 不自动修改文档或接受候选。
- 过期来源、内部冲突和无来源结论有确定性测试。

## C4：Learning

### 工作

- 增加 LearningSessionState、LearningAttempt、问题/提示层级和理解状态。
- `/learn` 默认先获取用户解释，再分析正确点、遗漏和误解。
- 使用 `waiting_user` 跨多次 Agent run 保存当前问题、尝试和下一步，不从整段聊天重新推断。
- 支持引导问题、逐级提示、反例、迁移题和 needs_review。
- 可生成候选理解记录，但不能自动标记掌握或写正式知识。

### 验收

- 用户尚未尝试时不直接给出完整标准答案。
- Session 在关闭/重新打开会话后能恢复等待状态。
- 理解状态变化有对应用户尝试和分析依据，不按消息数量计算。
- Learning 默认没有正式知识或文档写权限。

## 暂不进入

- 第二套 Agent Runtime、通用工作流引擎或多 Agent 编排。
- A2A、Agent 市场和自动学习/修改 Skill。
- 完整知识图谱、图数据库、向量数据库或知识图谱画布。
- 后台自动维护全部知识、静默接受候选或自动改写原文。
- 用户可编辑的复杂 Knowledge Control 规则引擎。
- 全自动间隔重复、全量长期记忆和跨设备同步。
- Generated View 自动刷新、静默覆盖或三方自动合并。
