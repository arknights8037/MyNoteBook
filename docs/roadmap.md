# 后续开发路线图

本文只维护尚未完成的工作。已完成实现以 [当前架构](architecture.md)、[Agent Runtime](agent-runtime.md) 和代码测试为准，历史过程通过 Git 追溯。

## 总体策略

```text
G0 现有架构稳定性门禁
  -> C1 最小认知内核
  -> C1.5 Runtime 接线与自托管修改门禁
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

## C1.5：Runtime 接线与自托管修改门禁

状态：**完成（2026-07-15）**。外部调用方已只通过受控通信接口提交“已完成什么，请同步相关知识”，没有指定文档或块；同一 Agent Runtime 自主检索、读取、选择、修订并生成待确认修改，最终通过 MCP 批准多文档原子写入。全过程没有使用桌面点击、Playwright 或直接数据库正文写入。

### 工作

- 为一次 Agent 运行集中编译可追溯的 Runtime 输入，避免 UI 编排分别传递 Prompt、ExecutionPolicy、工具和输出契约后产生漂移。
- 保持写入只能由现有 command/Patch 提案、审阅选择、revision 校验和 Rust transaction 完成；模型、Cognitive Output Contract 和工具 observation 均不能直接写文档。
- 增加启动后可重复的自托管 smoke：使用项目内置 Agent 能力读取隔离测试页面、提交最小修改提案、在审阅面板确认，并验证数据库 revision、transaction、audit 与撤销边界。
- 将 smoke 使用的页面和修改限定为固定非敏感内容，不读取或修改项目知识文档。
- 增加带 capability token 的本地 Agent 通信队列与 stdio MCP 提交、查询、批准/拒绝工具；请求仍由前端既有 `useAgentRun` 和同一 `ToolLoopAgent` 消费，不创建旁路 Runtime。
- 允许 Agent 在同一次运行中对所有已通过 `read_document` 读取的目标文档生成 Patch；读取结果包含稳定 block ID、顺序和 revision，Rust 持久化边界要求每个目标文档都出现在该任务的 context source 中。

### 验收

- 先把本次任务的真实完成内容写入跟踪记录，再通过项目通信接口或 MCP 提交一段任务完成摘要；调用方不得指定要更新的文件、页面、块或位置。
- Agent 必须自行搜索和读取相关知识文档，基于真实 revision 与 block provenance 选择目标，生成可审阅 Patch；通信入口不得创建第二套模型循环，也不得绕过 ExecutionPolicy、Patch/Diff、确认和 Rust transaction。
- 启动当前项目后，可以仅通过项目提供的 Agent、工具、Patch 审阅和确认事务提交一次文档修改。
- 提交前数据库正文与 revision 不变化；确认后只修改目标块且 revision 递增一次。
- Agent Task、Patch Set、Tool Call、Confirmation 和 Document Transaction 可追溯，应用重启后结果仍可读取。
- 拒绝提案或 revision 冲突时不写入；已确认修改仍可通过现有撤销能力恢复。
- 前端全量测试、类型检查、lint、生产构建和 Rust 测试通过。

### 实际执行记录（2026-07-15）

- 新增 `prepareAgentRunExecution()`，把 Prompt、Context、System Prompt、Intent、ExecutionPolicy、外部工具与可选 Output Contract 编译为单一冻结输入；结构化认知 contract 与写入提案权限同时出现时会在进入模型循环前拒绝。
- 启动 `pnpm tauri dev` 后，通过项目内置 Agent 在固定隔离页“新文档”提交最小修改。真实 DeepSeek 工具循环完成读取页面大纲、读取当前页和提交修改提案，审阅面板只显示 1 个目标块；用户确认写入正常，数据库 revision 从 7 增至 8，Patch 状态为 `accepted`，正文为“状态：已提交（C1.5）”。
- 首次纵向运行发现并修复权限范围漂移：Agent 无显式选区时，启发式相关块只能帮助定位，不能把 `current_document` 写入白名单缩窄到单块；显式选区仍保持最小范围。修复后同一真实任务成功进入 Patch 审阅与确认事务。
- 增加 `Ctrl/Cmd+Shift+A` 稳定 Agent 入口并补测试；同时修复快捷键接线首次实现造成的 `openAiChat` 初始化顺序错误，冷启动重新验证通过。
- 已增加 migration `0015` 的 `agent_requests` 通信队列、前端轮询消费者和 `mynotebook-agent` MCP 客户端。能力令牌仅从环境变量读取；提交只进入队列，批准/拒绝必须在查询 Patch 后单独调用，最终仍由既有确认与 Rust transaction 应用。
- migration `0016` 为通信请求增加版本化 `result_json`。同一次 Agent Runtime 在完成分析或生成待审阅 Patch 时回传 `outcome`、自然语言 `summary`、Patch 数量和目标文档 ID；MCP `get_agent_request` 将其作为标准 `result` 信封返回并在批准/拒绝后保留，调用方不再自行检查知识库或从 UI 推断执行结果。
- 已扩展 `read_document` 返回块级 provenance，并将运行内成功读取的文档登记为只限该 revision 的可写候选；未读取的跨文档命令、版本不符或不在 task source 中的目标都会被拒绝。
- 通过 stdio MCP 开发接口复现并定位重复目标缺陷：历史任务 `a0785080-c1a1-49d8-8233-d34a44dbbb00` 的一次 `propose_document_patches` 同时提交了同一块的 `replace` 与 `insert_after`，工具审计错误标为 `completed`，直到结果持久化或批准阶段才被后置门禁拒绝。根因是复杂提案工具只有单项 schema，没有批级互斥约束。
- 已将模型可见的复杂提案工具收敛为 `submit_document_edits`：顶层 `documents` 可包含多个目标，每个 documentId 只声明一次；`replace` 只使用 `targetBlockIds`，插入只使用 `anchorBlockId`，Runtime 再编译为既有内部 Patch。每个文档内 targets 必须互斥，同一块的替换与补充必须合并；不同文档可以在同一提案中同步维护重复事实。非法提案返回可修正的工具错误，并仅允许重新规划一次完整提案。
- 多文档批准不再依赖单个当前编辑器快照。前端按目标文档加载各自 canonical content、blocks 与 revision，生成独立投影后一次提交；Rust 在同一个 SQLite transaction 中校验全部 Patch、更新全部目标、写入逐文档 transaction 与统一 batch confirmation。任一文档 revision、before、after 或写入失败都会回滚整批；撤销同样按 batch 原子恢复全部文档。
- 工具重构后通过真实 stdio MCP 请求 `agent-request-b0ec8958060a8a5633f1474b` 验证模型链路。Agent 自主执行多次搜索、读取两个候选文档，最终调用 `submit_document_edits` 并生成同一文档内两个互不重叠的 edit；没有继续调用已移除的旧提案工具。该诊断提案已通过 MCP 拒绝，请求完成且对应 Document Transaction 数量为 0。此次知识库现状只需要修改一个文档，因此真实多文档原子批准仍需隔离 fixture 纵向 smoke；代码级多文档分组、批量投影、仓储输入与恢复映射回归已通过，Rust 批量事务实现通过编译和全量既有测试。
- 修复后再次通过通信接口提交不指定文档或块的自然语言同步请求 `agent-request-fb25b1f79f80ef6b6bc97707`。Agent 自主检索并选择目标，最终只生成一个合并后的 `replace` Patch，未出现目标重叠；该诊断提案已通过 MCP 拒绝，文档未写入。另一次诊断发现模型可因反复改写检索词耗尽轮次后以 no-change 结束，Prompt 已增加检索收敛和 blocked 语义约束，仍需后续纵向观察。
- 此前针对性验证：6 个关键前端测试文件共 49 项通过，覆盖新工具分组、跨文档解析、批量投影、恢复与拒绝；Rust Patch 集合约束 2 项通过。当时的真实通信测试只查询并拒绝提案，因此尚不能完成 C1.5；该历史阻塞已由下述正式多文档批准与 revision continuation 纵向验收解除。
- C2 未开始；`/research` 仍未绑定认知运行与候选确认 UI。
- 最终门禁：`pnpm test:run` 105 个测试文件通过、2 个跳过，377 项通过、5 项跳过；`pnpm typecheck`、`pnpm lint`、`pnpm build` 均通过；Rust 49 项通过、3 项显式忽略。生产构建仅保留既有 chunk size 与动态/静态 import 提示。
- 上述“固定隔离页 + 明确目标内容”的旧纵向 smoke 单独看只证明当前页写入闭环；C1.5 的最终完成依据是下述不指定文档/块的正式 MCP 自主同步、修订和多文档批准记录。
- 2026-07-15 通用 Agent 生命周期差异审计已写入 `docs/agent-runtime.md`。确认 AI SDK 会维护同一次 ToolLoopAgent 内的 tool messages，但旧 MCP reject → submit 会创建全新 task，不携带上一版 summary、Patch、canonical provenance 或反馈；因此微小修订会错误重跑完整发现循环。migration `0018` 与 stdio MCP `revise_agent_request` 现让同一 request 保存 previous task、feedback 和 revision count。
- revision continuation 会由 Runtime 重新加载上一提案目标的 canonical provenance，把上一版 summary、完整 Patch 和授权人反馈编译为紧凑修订输入；ExecutionPolicy 只允许 `submit_document_edits`，最多 6 轮，不允许重新搜索或扩大文档范围。若反馈需要新资料，必须拒绝当前提案并创建新的完整 request。
- 写提案 Runtime 的最低 output token 预算由 2048 提高为 16384，并同时提高 task tokenBudget；标准 result 现在保存 provider `finishReason` 与聚合 input/output/total usage。通信消费者不再把 cancelled 或缺少 result 的任务标为 completed。
- `read_document` 改为直接从 canonical `content_json` 生成 revision、plain text 与 blocks；`submit_document_edits` 在工具调用当下验证文档已读取、目标 block 来自该次读取、同文档目标互斥且 replace 非 no-op。旧的“工具成功、结果阶段才过滤全部 Patch”路径已消除。
- 结构化块往返缺陷已修复：此前 `read_document` 只暴露 `plainText`，导致 `tableBlock` 的 TSV 投影被模型按普通段落写回；Rust 又只比较可见文本，将“段落 → tableBlock”的同文本结构修复误判为 no-op。现在 canonical block 同时返回 `contentJson` 与 Markdown，tableBlock replacement 必须解析为唯一 Markdown pipe table，TSV/普通段落会在工具入口被拒绝，真正的表格 no-op 按 canonical Markdown 判断，Rust 允许合法的同文本结构恢复。
- 启动恢复通过 Rust transaction 自动拒绝未绑定任何通信 request、且已被更新任务取代的孤立 `waiting_confirmation` 提案；Patch、task 和 confirmation 审计同步更新。手动 MCP orphan 清理入口已移除，脏状态不再转嫁给外部调用方。
- 真实 stdio MCP 纵向验收使用 request `agent-request-adeff126b29459a708aec22a`。首次 task 自主检索并生成 2 文档/4 Patch 提案，`finishReason=stop`，input 84076、output 7412、total 91488 tokens，证明输出不再受 2048 限制。随后同一 request 通过 `revise_agent_request` 仅统一一处术语；revision task `53231b62-4560-4526-b89a-eb135636f8eb` 只调用一次 `submit_document_edits`，没有 `search_documents`/`read_document`，result 报告 input 18519、output 2400、total 20919 tokens。
- 修订版依据 Agent 标准 result.summary 批准，没有由外部调用方读取知识正文复核。最终 request 为 `completed`、4 个 Patch 均 accepted；Agent 汇总为 2 篇知识内容、4 处 edit、无新增未处理项。Rust batch 生成 2 条 applied `agent_document_transactions`，覆盖 2 个不同 document，验证 migration `0017` 的 `UNIQUE(task_id, document_id)` 与多文档原子批准路径。
- 表格结构纵向修复使用 stdio MCP request `agent-request-14aa5c63f8ff0465866efcbd`。初始 task 自主执行 `search_documents`、`read_document` 和 `submit_document_edits`，生成 1 个完整三列 Markdown 表格 Patch；同一 request 的 revision task `d4c0585e-035b-47e4-adc7-d681a920b6e2` 只调用一次 `submit_document_edits`，未重新检索或读取。调用方依据标准 result.summary（1 个目标块、恢复 1 个三列表格、保留 21 行事实、无未处理项）批准，没有读取知识正文复核；最终 request 为 `completed`、error 为空、Patch 为 `accepted`、transaction 为 `applied`，结构索引确认目标位置为 `tableBlock`，文档 revision 从 3 增至 4。
- 表格修复后的最终门禁：`pnpm test:run` 107 个测试文件通过、2 个跳过，400 项通过、5 项跳过；`pnpm typecheck`、`pnpm lint`、`pnpm build` 均通过。Rust 全量测试 52 项通过、3 项显式忽略。首次 Rust 全量运行另发现 `storage::tests::migrates_managed_files_and_rewrites_local_metadata` 在 Windows 并发测试下清理已关闭 SQLite/WAL 临时目录时遇到 error 32；业务断言已通过，测试清理现使用最长 2 秒的有界文件锁重试，针对性测试与随后默认并发全量均通过。生产构建只保留既有 Rollup pure annotation、动态/静态 import 与 chunk size 提示。
- C1.5-R Agent 能力 Review 后完成过程与稳定性收口：AI SDK `onStepStart` / `onStepEnd`、工具生命周期、显式只读重试和授权等待进入同一前端时间线；UI 不显示隐藏思维链，只显示可验证行动摘要。`allowedTools` 现在同时裁剪 Provider ToolSet 与 `activeTools`，`/plan`、`/research`、`/create` 使用 intent 最小工具包，continuation 只暴露 `submit_document_edits`。
- `maxRetries` 已接入 Provider SDK；显式 `retryable` 的幂等只读工具使用有界退避并产生 retry 事件，相同工具与相同规范化参数失败后不能原样重复。`safeAuditJson` 的大结果改为合法版本化截断 envelope，不再产生无法解析的 JSON。
- `read_document` 新增 `cursor`、`maxChars` 与 `blockIds`，默认正文摘要从 12,000 字符缩至 2,000，并返回 `truncated` / `nextCursor` / 字符预算统计；前端在本地将 canonical `contentJson` 转为 Markdown 后删除 JSON 树，模型不再同时接收整篇正文、JSON 与 Markdown 三份结构。内置工具的模型可见描述统一取自 `AgentToolRegistry`，Rust 保留独立安全 schema 并对分页参数重复校验。
- C1.5-R 功能维护新增 Agent 项目组和可折叠工作记录管理器。项目可绑定多个文档分组作为默认作业区；默认 FTS 检索由 Rust recursive CTE 限定在根节点及后代，证据不足时模型仍可显式使用 `scope=global` 外出搜索，且只有搜索实际发现的文档可继续读取。
- Agent 项目管理进一步改为 Codex 风格文件夹树：对话按所属项目直接嵌套，创建项目时同步填写名称和选择作业区；项目、对话均支持持久化置顶，列表按置顶优先和最近更新排序。
- migration `0019` 增加 `agent_workspace_state`，项目、作业区与会话消息以版本化快照持久化到 SQLite；`agent_tasks` 新增 `project_id`、`conversation_id`，任务不再只靠当前文档 ID 表达归属。旧 localStorage 会话键只清除、不迁移，无工具模型的静默兼容 fallback 已删除。
- 维护前数据库已备份为 `editor-pre-agent-workspaces-20260716-014346.db`；既有对话、任务、工具调用、请求、确认、Patch、事务和审计已清空。文档库仅保留 `Agent MVP` 根组及其 10 个后代文档，FTS 已重建且外键检查通过。

## 工作空间视图一期

状态：**完成（2026-07-16）**。

- 空间树已统一承载文档、思维导图、幻灯片、UML/流程图和表格；所有创建入口共用类型选择器，并保留父子位置、拖放和右键删除能力。
- 思维导图使用版本化 canonical 数据、MindElixir 人类编辑器、左右分支继承、稳定编辑焦点、非模态右键菜单、JSON/指向性文本导出和 Agent 读取工具。
- 幻灯片采用受限模板与 slot；UML 采用受限 Mermaid flowchart 与语义节点修改；表格复用 rows 和 `TableField`，独立视图使用稳定的轻量编辑器。
- 结构化视图具备 repository、service、revision history、验证器和语义 operation schema。幻灯片、UML、表格的 Agent read/create/edit/convert 工具尚未暴露，作为后续增量，不进行实时共享数据映射。
- 详细边界见 `docs/workspace-views.md`。

## C2：Research 完整闭环

状态：**进行中（2026-07-16，C2.1 与 C2.2 功能已落地，待真实 Provider/Tauri 总验收）**。

### 已完成：C2.1 结构化 Research 运行与消息结果

- `/research` 已绑定 Research Mode、`research-conclusions` v1 模板和 `research-result` v1 Output Contract；运行策略由 Cognitive Compiler 按 tool tag 收紧为只读工具集，不再经过 legacy command/Patch 输出协议。
- Research contract 已区分 Claim、Evidence、Assumption、Inference、Limitation、Conflict 和 Question，并支持条目间 `supports`、`conflicts_with`、`derives_from`、`relates_to` 关系提案。
- Evidence 和 `verified` 条目必须带可定位的 document/block/revision/quote 来源；重复条目 ID、自引用或悬空关系会在 Runtime 结果边界被拒绝。
- 当前 assistant 消息展示结构化摘要、条目类型、验证状态、来源跳转和未解决问题；结果及 mode/template/contract/run/session provenance 随 Agent 对话快照持久化。
- Tauri 运行会创建并完成 Cognitive Session，session state 保存结构化结果；失败或取消时同步取消 active session。

### 已完成：C2.2 Candidate 确认闭环

- Research 条目会映射为 `candidate` Knowledge Object，并保存多来源、Validation、原始 item、session、run、mode、template 和 output contract provenance；Conflict 作为带 `researchKind=conflict` 的 claim candidate 保存，不扩张数据库 object type。
- 当前 Research assistant 消息支持逐项接受、编辑后接受、拒绝和保留，candidate id、version、决策状态、来源状态、编辑内容和错误随对话快照持久化。
- 编辑使用 Knowledge Object 乐观版本更新，增加 candidate version，但不替换原始 generated run、mode、template provenance。
- 接受前重新读取所有来源文档 revision 和稳定 block；任一来源删除、revision 变化或 block 消失都会追加失败 Validation、标记 `stale` 并阻止批准。
- 接受只将 candidate 转为 `approved`；不会生成 active Rule/Decision，也不会修改原文。关系提案只有在两端候选都经用户批准后才写入，避免悬空或未确认关系。

### 待完成：C2 总验收

- 使用真实 Provider 和 Tauri 完成 `/research` → 工具循环 → 结构化结果 → 来源定位 → candidate 创建 → 用户确认的纵向 smoke。
- 在 smoke 中记录编辑后接受的 version/provenance、过期来源拒绝和正式知识写入前后数量，完成后再将 C2 整体标记完成。

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

状态：**功能完成（2026-07-16）**。Review 的结构化只读闭环与自动化验收已落地；真实 Provider/Tauri 联合 smoke 可与仍待执行的 C2 总验收一并完成。

### 已完成

- `/review` 已绑定 Review Mode、`review-findings` v1 模板、`review-result` v1 Output Contract 和 Cognitive Session；Provider 只看见按 tag 编译后的只读工具，不能在 Review run 内提交 Patch。
- Review issue 支持 unsupported claim、missing source、logical gap、conflict、undefined term、missing scope/assumption、outdated information、evidence mismatch 和 ambiguity，并携带严重程度、解释、涉及文本、建议动作与稳定来源。
- Contract 确定性拒绝单来源 conflict、带来源的 missing_source、无来源却标为 unsupported_claim，以及没有来源的 outdated information/evidence mismatch。
- Runtime 结果边界会重新读取 document revision 和稳定 block；来源失效时标记原 issue 为 stale，并追加本地生成的 outdated information issue，禁止直接转换为修改。
- 当前 assistant 消息展示结构化 Review 结果、来源跳转、严重程度、未解决问题和 stale 状态；结果与 mode/template/contract/run/session provenance 随对话持久化。
- 用户明确点击“处理此问题”后，才将单个 issue 编译为新的 `/edit` 请求，复用现有读取 provenance、Patch 校验与确认流程；Review 自身不修改文档、不创建或接受知识候选。
- `/find-assumptions`、`/find-conflicts`、`/extract-claims` 作为薄命令绑定同一个 Review Mode 和 contract，只改变任务焦点，不复制分类与校验规则。
- MCP Server 新增 `submit_cognitive_request`，通过持久化 `mode` 复用桌面 Cognitive Runtime；`get_agent_request` 回传 `result.cognitive`。真实 Tauri/DeepSeek smoke 请求 `agent-request-8195080ca055e74708f2f696` 已完成，终态为 `completed/no_change`、0 Patch，并返回 7 条结构化 Review issue。
- 委托确认链升级到 Context Bundle v2 与 `ConfirmationEnvelope`：冻结来源正文纳入 hash，CLI 导出不再丢弃 Context Bundle；Verifier 将 frozen input、外部 output、Artifact、Evidence 和 checks 固定成同一份带 hash 的确认材料。前端重复 plain-text projection 已移除，附件、图片和折叠块在没有无损 Markdown codec 前禁止 Agent replace。
- 真实 smoke 暴露并修复 Provider 忽略 JSON response format 的兼容问题：主 ToolLoopAgent 使用原生 `Output.object`，失败后仅对已有结果执行无工具结构修复，不重跑检索；修复调用 usage 合并进标准结果信封。

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

状态：**功能完成（2026-07-16）**。Learning 多轮状态机、持久化恢复、只读权限和自动化验收已落地；真实 Provider/Tauri 联合 smoke 可与 C2/C3 一并完成。

### 已完成

- 新增 `LearningSessionState`、`LearningAttempt`、理解状态、0–3 级提示、当前问题、下一步和版本化 `learning-turn` v1 Output Contract。
- `/learn` 已绑定 Learning Mode、`learning-coach` v1 模板和 Cognitive Session；首次 turn 由本地状态机直接生成解释题，不调用 Provider，因此确定性保持 `not_assessed`、反馈为空、候选理解为空，也不可能提前泄露模型标准答案。
- 同一 conversation 中的普通用户回复会优先恢复最近的 `waiting_user` Learning Session，使用持久化 state 作为写真源并追加一次真实 Attempt，不从整段聊天或消息数量重新推断状态。
- 每次理解状态变化必须携带当前用户尝试的可见 evidence；提示只能逐级增加，支持 guided question、hint、counterexample、transfer question、demonstrated 和 needs_review。
- Learning 输出、Attempt、下一问题、提示级别和临时候选理解记录会显示在当前 assistant 消息并随对话恢复；候选理解只展示，不写 Knowledge Object，也不自动标记“掌握”。
- Learning Mode 的工具策略为只读，不包含文档或知识写提案工具。运行失败时，已恢复 session 回退为原 `waiting_user` state，不丢失学习进度。
- SQLite repository 测试验证了 service 重新创建后仍能按 conversation 恢复等待状态；状态机测试验证理解变化基于 Attempt，而不是消息数量。

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
