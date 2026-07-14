# 桌面端知识库 Agent MVP 跟踪文档

最后更新：2026-07-13

本文档是 Agent MVP 从路线图到执行任务的单一跟踪入口。它基于当前项目实现状态整理，不只是复述路线图。

## 目标闭环

MVP 只验证三个核心问题：

1. Agent 能否准确读取编辑器上下文。
2. Agent 能否安全生成结构化块修改。
3. 用户是否愿意在 Diff 确认后接受 Agent 的修改结果。

首个可演示纵向切片：

```text
选区/当前文档
-> AI 改写
-> 生成 Patch
-> Diff 预览
-> 用户接受
-> 写入文档
-> 撤销整次 Agent 操作
```

MVP P0 不做 A2A、多 Agent、Agent 市场、长期后台任务、自动学习 Skill、云同步、完整 MCP 生态和无监督自动执行。P0 之后已增加受控 MCP Client 工具接入，但 Resources、Prompts、OAuth 等完整生态仍属于 Later。

P0 之后已加入自动化定义、运行队列和统一审计页面框架；后台调度器与无人值守模型执行仍不属于当前 MVP。

## 当前状态

### 实现评估结论（2026-07-13）

- **核心 MVP：代码闭环已完成。** 当前文档/选区读取、结构化 Patch、Diff 确认、原子写入、版本冲突保护、持久化恢复和安全撤销均已有实现与自动化测试。
- **知识库 Agent：P1 主链路已完成。** SQLite FTS5 检索、按需阅读、来源记录、稳定块跳转和最多 6 轮的原生工具循环已经接通。
- **受控扩展：已有可用骨架。** Slash Command、授权人暂停/恢复、Skill 注入与文件读取、自动化/Skill 停用草稿、自动化队列和统一审计页面已经存在；后台调度器和无人值守模型执行尚未实现。
- **发布就绪度：尚未完成。** 单元/组件/仓储测试和构建已通过，但 `tests/e2e` 仍只有占位文件，尚缺真实 Tauri UI 纵向回归、全 Provider 联调和 Windows 干净系统安装验证。

本次评估验证记录：

- [x] `pnpm test:run`：82 个测试文件通过、1 个跳过；304 项测试通过、2 项跳过。
- [x] `pnpm typecheck`：通过。
- [x] `pnpm build`：通过；存在大 chunk 与动态/静态混合导入警告，不阻断构建。
- [x] `pnpm lint`：0 error、1 warning；`AiChatPanel.vue` 的 `v-html` 仍需做发布前安全复核。
- [x] `cargo test`：21 项通过、1 项诊断测试忽略；包含真实 stdio MCP initialize、工具发现和调用握手测试。
- [ ] Playwright E2E：尚无实际用例。

状态标记：

- [x] 已具备或基本完成。
- [ ] 进行中 · 已有雏形但不满足 MVP 闭环。
- [ ] 尚未开始。
- `P0` 首个可演示版本必须完成。
- `P1` MVP 后半段或第二个演示版本。
- `Later` 明确暂缓。

已具备：

- [x] Vue/Vite + Tiptap 基础块编辑器。
- [x] 文档创建、编辑、自动保存、恢复、软删除、永久删除。
- [x] Tauri/Rust 桌面端壳与基础命令。
- [x] SQLite 文档与附件持久化。
- [x] AI Request 流式文本接口，支持 OpenAI、Anthropic、DeepSeek、Qwen、OpenAI-compatible。
- [x] 基础 AI 面板和模型配置 UI。
- [x] 文档 revision 乐观并发控制。

当前偏差和缺口：

- [x] 文档继续以 `documents.content_json/plain_text/revision` 为写真源，并已建立由 SQLite trigger 同事务维护的 `blocks` 规范化投影。
- [x] 编辑器已暴露 P0 所需的当前文档块、选中块和按块替换能力。
- [x] AI Edit 已从直接写入改为生成 Patch、展示 Diff、等待用户确认后写入。
- [x] SQLite FTS5 检索通过 `document_search` 和触发器同步文档标题、正文与删除状态。
- [x] Agent Runtime 已接入结构化 Patch、受限正则命令、工具注册表和最多 6 轮的通用工具调用循环。
- [x] Agent Runtime 已在 P0 之后增加受限 `execute_shell`：仅开放只读 PowerShell 查询和已知本机工具白名单，带参数校验、超时、输出上限与审计。
- [x] 本机工具层支持 Agent 在安全范围内选择超时和输出上限，并提供环境路径检查、PATH 工具发现与基础系统信息工具。
- [x] Agent 已提供 `/plan`、`/create`、`/interactive`、`/research`、`/review`、`/edit`、`/ask` 运行入口，并按意图限制只读或写入协议。
- [x] Agent 可在关键歧义处暂停并向授权人提问，收到回答后恢复同一次运行；停止任务会同步取消等待中的授权请求。
- [x] 已启用 Skill 的 `SKILL.md` 可注入系统提示词，Agent 可通过受限相对路径读取该 Skill 的文本资料。
- [x] 用户明确授权后，Agent 可创建停用的自动化或 Skill 草稿，不会自动启用、排期或执行。
- [x] 应用可导入 stdio/Streamable HTTP MCP 配置、发现外部工具，并把已启用服务动态接入 Agent；非只读工具逐次请求授权。
- [x] Agent 任务、补丁、来源、确认和文档事务记录持久化到 SQLite。
- [x] Agent 撤销使用持久化事务快照，并在 revision 变化后拒绝覆盖人工修改。
- [x] API Key 已迁移到 Tauri Stronghold；AI 设置不再把密钥写入 localStorage。

## 里程碑

### Demo 0：冻结 MVP 范围

目标：锁定 Agent 能做什么、不能做什么，以及首个纵向切片的接口边界。

- [x] P0 确认 MVP 只支持改写选中内容、当前文档问答、搜索知识库并回答、创建或修改块内容。
- [x] P0 确认 P0 写操作必须经过 Patch + Diff + 用户确认。
- [x] P0 初始范围不开放 shell；后续仅增加白名单只读 `execute_shell`，仍不开放任意脚本、`execute_sql`、任意文件访问或批量修改工作区。
- [x] P0 将接口、Patch 协议、任务状态、前端交互流程固化到代码类型和测试中。

### Demo 1：可信修改闭环

目标：完成最关键的选区改写闭环。

- [x] P0 从编辑器读取当前选区或当前块，返回稳定 block id、内容和文档 revision。
- [x] P0 建立前端本地 `AgentTask` 状态机，支持 running、waiting_confirmation、completed、failed、cancelled。
- [x] P0 让 Agent 输出 `BlockPatch` 草案，禁止流式直接写文档。
- [x] P0 校验 Patch 的 document id、block id、expected version、目标块和 after 内容。
- [x] P0 展示 Diff，支持接受选中修改和全部拒绝。
- [x] P0 用户确认后以一次编辑器事务写入。
- [x] P0 支持撤销最近一次 Agent 操作；待确认提案和最近可安全撤销事务可在重启后恢复。

### Demo 2：当前文档问答与知识库检索

目标：Agent 能读当前环境，并在跨文档回答时显示来源。

- [x] P1 建立当前文档上下文构建器，包含标题、正文、选中块和用户指令。
- [x] P1 建立 SQLite FTS5 本地文档关键词检索，返回 document id、标题和片段，并由触发器同步标题、正文与删除状态。
- [x] P1 Agent 回答中保留来源引用。
- [x] P1 引用可点击跳转到原文档及稳定来源块，并在编辑器中短暂高亮定位。
- [x] P1 用户可看到本次任务使用了哪些文档。

测试记录：

- [x] 2026-07-09 已在知识库中创建“公司员工操作测试 - Demo2”分组，覆盖差旅报销、采购审批、IT 入职与故障、信息安全外发四类员工高频问题。
- [x] 2026-07-09 已用 DeepSeek 通过软件界面完成 Ask 测试：答案命中制度要点，来源列表仅包含当前问题页和对应制度页。
- [x] 2026-07-11 来源按钮已支持稳定 block anchor 跳转和短暂高亮；旧文档级链接保持兼容。

### Demo 3：多工具、多 Patch、执行报告

目标：复杂指令可以连续调用工具，生成多个 Patch 并批量确认。

- [x] P1 Agent Loop 支持最多 6 轮工具调用。
- [x] P1 工具失败有结构化错误，不导致应用崩溃。
- [x] P1 模型结构化输出错误时不执行写入。
- [x] P1 任务运行时显示自然语言阶段、实时耗时和逐次工具状态；完成后保留轮次、调用参数、结果摘要、错误与使用模型。跨会话工具审计历史查询留待后续。
- [x] P1 支持从失败消息重试任务；重试会重新读取当前上下文和 revision。

### Demo 4：受控扩展与授权人协作

目标：在不放开任意写权限的前提下，让 Agent 能切换工作意图、请求关键决策并生成可审阅资源草稿。

- [x] P1 Slash Command 支持计划、创建、互动、调研、审阅、编辑和问答意图。
- [x] P1 `request_authorizer_input` 支持选项与自由文本，并可暂停、恢复或取消同一次任务。
- [x] P1 仅加载已启用且有效的 Skill；技能相对文件读取限制在对应 Skill 目录内。
- [x] P1 `create_automation_draft` 和 `create_skill_draft` 均需内联授权，且创建后保持停用。
- [x] P1 自动化定义、到期查询、去重入队、运行状态和统一审计页面已实现。
- [ ] Later 后台调度器、自动领取队列、无人值守模型执行和失败重试编排。
- [ ] Later Skill 自动发现/学习、外部插件市场和完整 MCP 生态。
- [x] P1 基础 MCP Client 支持 JSON 导入、启停、连接测试、工具发现与调用。
- [ ] Later MCP Resources、Prompts、Roots、Sampling、OAuth、旧版 SSE 和长连接会话管理。

## P0 任务看板

### 数据层

- [x] P0 SQLite 文档表、附件表、标签表。
- [x] P0 文档级 revision 乐观并发控制。
- [x] P0 兼容现有 `documents.content_json` 的块读取和写入。
- [x] P0 块级版本使用 Tiptap block id + document revision；`blocks` 表作为只读投影，不改变 `content_json` 的写真源地位。
- [x] P0 建立 Agent 任务、补丁、来源、确认和事务记录的持久化表；工具调用表已预留。
- [x] P0 Agent Patch 写入使用 SQLite 原子事务并保存事务快照。
- [x] P1 `blocks` 投影覆盖普通保存、Agent 写入、撤销和删除，并保留文档 revision。

### Agent Runtime

- [x] P0 基础流式模型请求。
- [x] P0 OpenAI、Anthropic、DeepSeek、Qwen、OpenAI-compatible 的独立配置、模型选择和运行时适配；跨 Provider 真实账号回归仍是发布验证项。
- [x] P0 前端任务创建、停止/取消和持久化状态更新入口；运行中使用 `AbortController` 终止模型请求和授权等待。
- [x] P0 Agent 状态机具备 5 分钟任务超时；重启时会把中断的 pending/running 任务标记为失败。
- [x] P0 工具注册表和白名单；只读工具已接入多轮执行，`replace_text_by_regex` 已接入本地命令执行。
- [x] P1 `replace_block`、`insert_blocks`、`create_document` 已接入独立本地提案生成器；新文档使用可撤销的 Rust 原子创建事务。
- [x] P0 结构化 Patch 校验和模型 JSON 输出解析；非结构化输出仅在安全候选范围内降级为单 Patch。
- [x] P0 最大工具调用轮次 6，最大失败重试 2，单任务最长 5 分钟。

### 上下文工具

- [x] P0 当前文档标题、标签、来源、作者、正文可传给模型。
- [x] P0 `getCurrentDocument` 的 P0 前端上下文能力。
- [x] P0 `getSelectedBlocks`。
- [x] P0 `getDocumentOutline`。
- [x] P1 `searchDocuments`。
- [x] P1 `readDocument`。

### Patch / Diff

- [x] P0 `proposeBlockPatches` 只生成补丁，不写入文档。
- [x] P0 `applyBlockPatches` 在用户确认后执行。
- [x] P0 Patch validator 校验版本、目标块、operation 权限、before 精确内容和 after 非空。
- [x] P0 Diff Viewer 支持单项勾选、取消全选、全部拒绝、全部接受和接受前手动编辑。
- [x] P0 版本冲突时停止执行并提示重新生成。
- [x] P0 `rollbackAgentTask` 可撤销最近一次持久化事务；重启和页面切换后会按 revision 恢复安全的撤销入口。

### Agent UI

- [x] P0 基础 AI 面板入口。
- [x] P0 Ask/Edit 模式。
- [x] P0 选中块后两步内调用 Agent。
- [x] P0 展示 Agent 等待确认、Diff，以及可展开的工具调用过程与完成状态。
- [x] P0 等待确认状态不再继续写入。
- [x] P0 任务失败后保留聊天记录并持久化任务状态；启动时恢复当前页面最近 50 条任务和待确认提案。

### 配置与安全

- [x] P0 Provider、endpoint、model、system prompt、max tokens 等配置项。
- [x] P0 OpenAI-compatible 配置、模型列表、普通请求与 Agent Runtime 适配。
- [x] P0 API Key 迁出 localStorage，使用 Tauri Stronghold。
- [x] P0 生产代码静态检查未发现完整 API Key 日志；发布前仍需对代理错误体和第三方日志做一次动态脱敏回归。
- [x] P0 Agent Runtime 错误与取消会收敛为任务失败/取消状态；写入通过原子事务和确认门禁避免半完成提交。
- [ ] P0 Windows 干净系统安装和首次运行测试。
- [ ] P0 为“选区改写 -> Diff -> 接受 -> 撤销”和“检索 -> 来源跳转”补齐 Playwright/Tauri E2E。

## 接口与数据结构草案

### P0 API

```text
createAgentTask(input) -> AgentTask
cancelAgentTask(taskId) -> AgentTask
getSelectedBlocks(context) -> SelectedBlock[]
getCurrentDocument(context) -> CurrentDocumentContext
proposeBlockPatches(taskId, instruction, contextScope) -> AgentPatchSet
applyBlockPatches(taskId, acceptedPatchIds) -> AppliedPatchResult
rollbackAgentTask(taskId) -> RollbackResult
```

### P1 API

```text
searchDocuments(query, options) -> SearchResult[]
readDocument(documentId, options) -> DocumentReadResult
getDocumentOutline(documentId) -> DocumentOutline
getTaskHistory(options) -> AgentTaskSummary[]
retryAgentTask(taskId) -> AgentTask
```

### AgentTask

```text
AgentTask
- id
- sessionId
- status: pending | running | waiting_confirmation | completed | failed | cancelled
- userInstruction
- contextScope
- model
- currentStep
- createdAt
- completedAt
- error
```

### AgentToolCall

```text
AgentToolCall
- id
- taskId
- toolName
- argumentsJson
- resultJson
- status
- startedAt
- completedAt
- error
```

### BlockPatch

```text
BlockPatch
- patchId
- taskId
- operation: replace | insert_before | insert_after | append
- documentId
- blockId
- expectedVersion
- before
- after
- reason
```

### AgentPatchSet

```text
AgentPatchSet
- taskId
- patches
- model
- contextSources
- createdAt
```

### 数据层默认策略

第一版先兼容现有 `documents.content_json`：

- 使用 Tiptap top-level node attrs 中的 block id 定位块。
- 使用文档 `revision` 作为 P0 的 `expectedVersion` 基础。
- Patch 应用时重新读取当前文档，确认 revision 和 before 内容匹配。
- 若当前文档在 Agent 生成 Patch 后发生变化，直接进入版本冲突，不做自动合并。

当前已建立以下只读块投影，由数据库 trigger 同步：

```text
blocks
- document_id
- id
- block_type
- block_index
- content_json
- plain_text
- document_revision
- updated_at
```

## 验收标准

Demo 1 完成标准：

- 用户选中一个或多个块后可以发起改写。
- Agent 能读取选区和当前文档必要上下文。
- Agent 只能生成 Patch，不能绕过确认直接写入。
- 用户能看到每个 Patch 的修改前、修改后和修改原因。
- 用户可以逐项接受或拒绝修改。
- 接受后文档内容正确更新并持久化。
- 文档在 Patch 生成后被用户修改时，应用 Patch 会报告版本冲突。
- 用户可以一键撤销整次 Agent 修改。
- 取消任务后不会继续写入。

Demo 2 完成标准：

- [x] Agent 可以回答当前文档问题。
- [x] Agent 可以搜索本地知识库。
- [x] 跨文档回答至少带一个可点击来源。
- [x] 用户能看到本次任务读取了哪些文档。
- [x] 已用公司员工高频场景测试：差旅报销、采购审批、IT 入职与服务台、信息安全外发。

发布前完成标准：

- 普通用户可以独立完成模型配置。
- API Key 不以明文形式写入 localStorage、普通 JSON、SQLite 明文字段或日志。
- Agent Runtime 异常不会导致编辑器崩溃。
- 失败任务不会产生半完成写入。
- Windows 安装包可以在干净系统上运行。

## 风险与约束

### 范围膨胀

- P0 只做可信修改闭环。
- A2A、多 Agent、完整 MCP 生态、长任务和外部 Agent Adapter 继续属于 Later；基础 MCP Tools Client 和受控 Skill 已作为 P1 扩展落地。
- 每个阶段必须有可演示用户路径。

### 上下文过长

- 默认发送选区、标题、大纲和邻近块。
- 不默认发送整个工作区。
- 超长文档通过工具按需读取。

### 模型覆盖用户内容

- Patch 必须携带 `expectedVersion`。
- 写入前再次读取并校验当前版本和 before 内容。
- 冲突时停止执行，提示重新生成。

### 修改不可解释

- 每个 Patch 必须带 `reason`。
- 任务过程展示工具调用和来源。
- 任务、工具调用、Patch、用户确认都要可查询。

### 安全

P0 工具白名单：

```text
get_current_document
get_selected_blocks
get_document_outline
search_documents
read_document
find_blocks_by_regex
read_skill_file
request_authorizer_input
execute_shell (restricted read-only allowlist)
inspect_environment_paths
discover_local_tools
get_system_info
create_automation_draft (authorized disabled draft)
create_skill_draft (authorized disabled draft)
replace_block
insert_blocks
create_document
```

P0 禁止：

```text
delete_document
unrestricted_execute_shell
execute_sql
arbitrary_file_access
batch_modify_workspace
```

## 下一步执行建议

当前不应继续重复建设 Demo 1，而应先把已完成的代码闭环推进到可发布、可回归状态：

1. **P0 · 补真实 E2E。** 覆盖选区改写、无选区定位、多 Patch 勾选、拒绝、版本冲突、接受、重启恢复和撤销；检索链路覆盖来源展示、页面跳转和 block 高亮。
2. **P0 · 做 Windows 发布验收。** 在干净系统验证安装、首次数据库迁移、Stronghold、模型配置、升级恢复和卸载重装，并记录可复现步骤。
3. **P0 · 完成安全回归。** 验证 API Key/Authorization 不进入应用日志、错误提示或审计 JSON；复核 `v-html` 渲染边界与 AI Markdown 清洗策略。
4. **P1 · 做 Provider 联调矩阵。** 至少分别验证 OpenAI、Anthropic、DeepSeek、Qwen 和一个自定义兼容接口的 Ask、结构化 Edit、工具调用、取消与超时。
5. **P1 · 补跨会话审计能力。** 为工具调用和自动化运行增加分页、筛选、导出与保留策略，避免只依赖最近 300 条页面查询。
6. **Later · 再决定是否启用后台自动化。** 只有在任务领取、幂等、权限、失败重试和无人值守写入策略明确后，才接入桌面调度器与模型执行器；默认继续保持草稿停用和人工确认。
