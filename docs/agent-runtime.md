# Agent Runtime 与工具协议

MyNoteBook 的 Agent 是受控的本地知识协作者。它可以读取许可范围内的文档、知识和外部工具结果，生成回答或结构化修改提案；它不能绕过本地权限、确认与可信写入边界。

## 1. 入口与执行流程

`useAgentRun` 负责一次交互式运行的前端编排。它先通过 `prepareAgentRunExecution()` 生成单一冻结的 Runtime 输入，再由 `runAgentToolLoop` 将 Agent 模式交给 `AiSdkAgentRuntime` 的 AI SDK `ToolLoopAgent`。

```text
用户输入 / Slash Command
  -> 冻结项目、会话、作业区、文档、选区、Provider 和模式
  -> 创建带 projectId / conversationId 的 AgentTask
  -> 编译 Skill 摘要、Context Bundle 和 ExecutionPolicy
  -> ToolLoopAgent：模型 -> Tool -> Observation -> 下一轮
  -> 本地校验最终结构化输出
  -> 回答，或 command/Patch 提案
  -> Diff / 用户确认 / Rust transaction
```

Ask 使用普通流式 Markdown 请求；Edit 生成受控 Patch；Agent 使用真实工具循环。Slash Command 只选择 intent 和策略，不包含独立业务 Runtime。

页面内可以通过浮动 AI 按钮或 `Ctrl/Cmd+Shift+A` 打开 Agent。Agent 模式未显式选择块时，写入边界是当前文档的现有块；文本相关性推断只帮助定位，不能把 `current_document` 权限意外缩窄。存在显式块选区时，写入范围仍严格限制在选区。

## 2. ExecutionPolicy

每次 AgentTask 保存一份 `ExecutionPolicy v1`：

- `maxToolRounds`
- `maxDurationMs`
- `maxToolFailures`
- `tokenBudget`
- `allowedTools`
- `riskLevel`
- `allowUserInput`
- `allowWriteProposals`
- `maxRetries`

当前通用默认值为最多 48 轮、15 分钟、10 次工具失败和 4 次重试；标准化边界允许 1–96 轮、1 秒–45 分钟和 0–20 次工具失败。`maxRetries` 会直接传给 Provider SDK；显式返回 `retryable=true` 的幂等只读工具也可在该上限内自动重试，写入提案、草稿和未知副作用工具不会自动重试。复杂批量提案 `submit_document_edits` 每个任务最多可修正提交 4 次，且相同失败参数仍禁止原样重放。具体任务、intent 或 Cognitive Mode 可以收紧这些值，但不能绕过 Runtime 检查。

内置和 MCP 工具带有代码级 tags。Cognitive Run 编译时把 tags 解析成稳定工具名，并与基础 `allowedTools` 取交集；denied tags 优先。Runtime 热路径不解释 tags，Mode、Template 与 Skill 都不能重新加入基础策略未授权的工具。

只读 intent 会关闭写入提案。MCP 工具通过运行时名称加入 `allowedTools`；`mcp:*` 只代表策略允许进入外部工具检查，不代表免除授权。

## 3. Context Bundle

模型调用前，`compileContextBundle()` 生成不可变 `Context Bundle v1`，保存：

- 当前 document、context scope 和 revision。
- document/block 来源及内容 SHA-256。
- 本地用户权限快照。
- 当前有效 Rule、Decision 和冲突槽位。
- Provider、模型、token budget 与完整 ExecutionPolicy。
- correlation/causation ID 和整体 snapshot hash。

Knowledge Repository 已经落地。Agent 运行会查询当前文档可见的有效 Rule/Decision，并写入 Bundle；没有有效对象时保存空数组，不伪造上下文。

Context Bundle 是本次运行使用过什么上下文的 provenance，不是可变会话状态，也不是长期记忆。

## 4. Prompt 与结构化输出

当前 Prompt 由以下部分组成：

```text
基础安全与写入政策
+ 当前 Ask/Edit/Agent 模式
+ 已启用 Skill 摘要
+ Slash intent 指令
+ 当前任务与编译后的上下文
```

Skill 正文不会全部预注入。模型先看到 Skill ID、描述和入口摘要，需要时使用 `read_skill_file` 读取已启用 Skill 目录中的文本资料。

Agent 终态使用本地 Zod schema 校验为：

- `outcome`: `proposal | no_change | blocked`
- `commands`: 确定性写入命令
- `patches`: 复杂块 Patch
- `finalAnswer`: 面向用户的最终说明

写入提案工具成功只代表提案被 Runtime 捕获，并不代表文档已经修改。Runtime 会对最终 JSON 执行本地严格解析；结构不合法时不产生写入。模型必须支持工具调用，旧的无工具降级循环已移除，能力不足会直接报告配置错误，不再静默切换执行模式。

Agent MVP 使用文档 command/Patch 契约。Runtime 也可注入版本化 `AgentOutputContract<T>`：Prompt 加入 contract 指令，终态从正文或 reasoning 通道提取 JSON 并在本地严格校验；无效结构不会进入候选或写入。当前测试认知 contract 与文档提案共用同一 `ToolLoopAgent`，没有第二套模型循环。

## 5. 工具生命周期与取消

每次工具调用使用稳定 call ID，并遵循写前审计：

```text
构造 running AgentToolCall
  -> 写入 agent_tool_calls
  -> 审计成功后执行工具
  -> 更新同一 call ID 为 completed/failed
  -> Observation 返回模型
```

如果 `running` 审计写入失败，工具不会执行，避免外部副作用先于审计事实发生。

停止任务时，前端 AbortSignal 会携带 call ID 调用 Rust 取消注册表。`execute_rig_tool` 和 MCP future 通过 `tokio::select!` 退出；白名单命令设置 `kill_on_drop`，future 被丢弃时终止子进程。Runtime 等待已经开始的工具写入终态后才结束任务，不把后台仍在运行的调用伪装成已取消。

等待授权的请求会同步取消。资源草稿等不可安全中断的短事务会在写完审计后结束，不在中间留下未记录副作用。

## 6. 内置工具

| 工具                        | 风险           | 行为                                |
| --------------------------- | -------------- | ----------------------------------- |
| `get_current_document`      | read           | 当前文档、revision 和稳定块         |
| `get_selected_blocks`       | read           | 用户真实选中的块                    |
| `get_document_outline`      | read           | 标题大纲与 block ID                 |
| `search_documents`          | read           | SQLite FTS5 作业区/全库分层检索     |
| `list_document_groups`      | read           | 获取真实分组 ID 与子项数量          |
| `read_document`             | read           | 按 ID 读取正文、标签、块和 revision |
| `find_blocks_by_regex`      | read           | Rust 线性时间正则定位块             |
| `read_skill_file`           | read           | 读取已启用 Skill 内的受限相对路径   |
| `request_authorizer_input`  | read           | 暂停并等待授权人选择或文本          |
| `execute_shell`             | read           | 白名单 Windows/本机只读命令         |
| `inspect_environment_paths` | read           | 有界读取 PATH/PATHEXT/PSModulePath  |
| `discover_local_tools`      | read           | 发现安全名称的本机工具              |
| `get_system_info`           | read           | 系统、架构、CPU 和工作目录          |
| `create_automation_draft`   | draft          | 授权后创建停用自动化草稿            |
| `create_mcp_server_draft`   | draft          | 授权后创建停用、未信任 MCP 配置草稿 |
| `create_skill_draft`        | draft          | 授权后创建停用 Skill 草稿           |
| `replace_text_by_regex`     | write proposal | Rust 正则生成逐块替换提案           |
| `replace_block`             | write proposal | 完整替换允许范围内的块              |
| `insert_blocks`             | write proposal | 在稳定锚点附近插入内容              |
| `create_document`           | write proposal | 创建新文档提案                      |
| `create_group`              | write proposal | 创建分组及可选初始文档提案          |
| `submit_document_edits`     | write proposal | 按文档分组提交一批复杂或跨文档修改  |

Rust 正则引擎限制 pattern、flags、块数量、replacement 和编译内存，保证线性时间；不支持回溯引用或 look-around。查找和替换都不在 WebView 主线程构造模型提供的 JavaScript `RegExp`。

`execute_shell` 不接收脚本文本，只允许结构化白名单：PowerShell 查询、Git 只读子命令、`rg` 当前工作区搜索、`where.exe` 和开发工具版本查询。Rust 再次校验参数、路径、超时和输出上限。

## 7. MCP、Skills 与外部边界

Agent 运行开始时对已启用 MCP Server 执行 `tools/list`，将 JSON Schema 转换成 provider-safe 的 `mcp__...` 工具。服务只有同时满足“本地标记 trusted”和工具声明 `readOnlyHint: true` 才免逐次授权；其他工具在调用前等待授权人确认。

用户明确要求添加 MCP 时，任务 Agent 可经授权调用 `create_mcp_server_draft`。该工具只保存无密钥的 stdio 或 HTTP 配置，使用新 ID 避免覆盖已有服务，并强制保持 disabled、untrusted；新服务不会在当前任务中启动、连接或加入工具目录。Skill 创建沿用同一资源草稿边界，只写入停用的 `SKILL.md`，由用户在管理页审阅后启用。

MCP 返回值只作为不可信 Observation。它不能绕过 Patch/Diff，也不能直接更新 Knowledge Object。Tools、Resources、只读 MCP Server 与 Delegation 的完整边界见 [MCP Client](mcp-client.md)。

## 8. 项目组、作业区与持久化

Agent 对话按项目组管理。左侧采用项目文件夹树，项目下直接嵌套所属对话；创建项目时一次完成命名和文档分组作业区选择。项目与对话都可独立置顶，置顶项优先、其余按最近更新时间排列。每个项目保存一个或多个文档分组根节点作为默认作业区；其全部后代文档在一次运行开始时冻结成允许集合。`search_documents` 未声明 scope 时只检索该集合。若现有证据不足，模型可以显式调用 `search_documents(scope="global")` 扩大到全库；只有该次全库搜索实际返回的文档才会加入本次运行的可读集合，不能直接猜测 ID 越界读取。

项目、作业区和整组对话以版本化状态快照保存到 SQLite `agent_workspace_state`，不再使用 WebView localStorage 保存业务历史。旧历史键在启动时只删除、不迁移。`agent_tasks` 同时保存 `project_id` 和 `conversation_id`，因此重启后仍可从项目、会话、任务三层追踪作业归属；任务本身的 Patch、工具调用、确认和事务继续使用既有规范化审计表。

项目还提供本地 Agent 请求通信队列。持有 capability token 的调用方先通过 stdio MCP 读取项目、资料根、对话和 A2A 分支目录，再可在指定项目下创建稳定分支，并把任务路由到 `project_id` / `branch_id`。桌面应用轮询后会在该项目资料范围内运行现有 `useAgentRun`；同一分支复用同一条持久化对话，父分支关系随历史快照保存。未提供路由参数的旧调用继续作为未分组独立任务处理。跨文档写入只对本次运行已成功读取且 revision 未变化的文档开放，最终结果仍是待审阅 Patch。MCP 的提交动作不会批准或应用修改；查询 Patch 后必须另行批准或拒绝，应用仍走同一 Rust transaction。

## 9. Patch、确认与撤销

command 先由本地 `AgentCommandService` 展开为 Patch。每个 Patch 保存 task、document、block、target blocks、expected revision、before/after、operation 和 reason。

模型可见的复杂提案工具是 `submit_document_edits`。输入按 `documents` 分组，每个 documentId 只出现一次；一个提案可以包含多个已读取文档，以同步维护分散在多处的同一事实。`replace` edit 只接受 `targetBlockIds`，插入 edit 只接受 `anchorBlockId`，Runtime 根据读取快照补齐内部 Patch 的 `blockId`、expected revision 和 before。

`read_document` 支持 `cursor`、`maxChars` 和 `blockIds`。模型可见结果包含短 `plainText` 摘要、稳定 block provenance 和可编辑的 canonical `markdown`，并用 `truncated` / `nextCursor` 明确分页；原生 `contentJson` 只在本地转换边界用于生成 Markdown，不再重复发送给模型。结构化块不能只按可见文本往返：`tableBlock` 的 `plainText` 是 TSV 投影，仅用于阅读和检索；修改时必须以 `markdown` 为结构基线，并提交完整 Markdown pipe table。工具入口会拒绝把 tableBlock 替换为 TSV、空格对齐文本或普通段落，也会用 canonical Markdown 识别真正的结构 no-op；Rust 保存边界允许“可见文本相同、节点从普通段落修复为合法表格”的结构变更。

写入提案在进入确认队列前先执行批级约束。每个文档内的目标块必须互不重叠，同一块既要改写又要补充时必须合并为一个完整 `replace` edit。`replace_block`、`insert_blocks` 等简单命令也不能在同一文档中重复锚定同一块，正则替换不能与其他块修改混在同一批中。

复杂提案若在工具入口违反这些约束，会以失败 Observation 返回模型，不会记录为已捕获提案。Runtime 允许模型根据错误重新规划一次完整提案；第一次成功捕获后不能再提交第二批。即使上游校验遗漏，结果解析、通用 Patch 验证和 Rust 保存边界仍会独立拒绝未读取文档、同文档重叠、重复 target、无效锚点和 no-op 替换。

批准时，前端为每个被接受的目标文档加载独立 revision、canonical blocks 和 content，分别生成修改后投影。Rust 在一个 SQLite transaction 内验证并写入所有文档；任一目标发生并发变化或语义校验失败时整批回滚。每个文档保留自己的 `agent_document_transactions` 记录，统一 batch confirmation 用于一次性撤销整批修改。

用户可逐项接受、编辑 `after`、拒绝或接受全部。Rust apply 边界重新校验：

- task 和 Patch set 状态正确。
- Patch 属于目标 task/document。
- revision、block、before 和目标范围未变化。
- 接受决策覆盖整套提案。
- 结果 Tiptap JSON 可验证，投影包含接受后的可见文本。

最终 `plain_text`、`blocks` 和 FTS 由 Rust Document Core 重新生成。撤销只有在 resulting revision 仍未被后续人工编辑改变时执行；新文档只有仍为 revision 1 时才可由 Agent 撤销删除。

## 10. 与通用 Agent 工作过程的差异审计

| 生命周期环节        | 通用 Agent 的预期行为                 | 项目此前的差异                                               | 当前约束与处理                                                                             |
| ------------------- | ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 任务身份            | 一个用户目标可包含多次运行和修订      | 每次 MCP submit 都被当作全新目标                             | request 保持稳定 ID；revision 记录 previous task 与 revision count                         |
| 单次工具循环        | 自动携带本轮 assistant/tool messages  | 已由 AI SDK ToolLoopAgent 正常维护                           | 保持现有实现，不复制第二套消息循环                                                         |
| 跨运行 continuation | 复用前次结果、工具证据和授权反馈      | 拒绝后只保留新 Prompt，重新搜索和读取                        | revise 使用上一版 summary、Patch、document/revision/block provenance 和反馈                |
| 工具范围            | 修订只开放完成修订所需的最小工具      | 修订与首次发现拥有同一工具集                                 | continuation 只允许 submit_document_edits；canonical 文档由 Runtime 恢复，不由模型重新发现 |
| Context/Memory      | 短期运行状态与长期知识分开            | Context Bundle 只记录单次 provenance，不能表达提案修订链     | request revision 是短期 continuation；Context Bundle 仍是不可变运行证据，不充当长期记忆    |
| 输出预算            | 大型工具参数和最终答复有足够输出空间  | 默认 2048 同时限制多文档工具参数                             | 写提案运行至少 16384 output tokens；只读/认知运行仍受原 policy 约束                        |
| 终态诊断            | stop、length、cancelled、error 可区分 | 未保存 finish reason/usage，偶尔出现 completed + null result | 标准 result 保存 finishReason 与聚合 token usage；无 result 和 cancelled 进入 failed       |
| 审阅状态            | 修订、批准、拒绝是不同动作            | 只有 approve/reject；“重写”只能重新 submit                   | stdio MCP 增加 revise_agent_request；批准/拒绝仍只作用于当前提案                           |
| 恢复与脏数据        | 重启可恢复有效工作并自动隔离陈旧状态  | 无通信归属的旧 waiting_confirmation 会阻塞队列               | Rust 启动恢复原子拒绝已被更新任务取代的孤立提案，并写 confirmation 审计                    |
| 写入一致性          | 多目标变更一个事务成功或失败          | 旧表 task_id UNIQUE 与多文档实现冲突                         | agent_document_transactions 使用 UNIQUE(task_id, document_id)，batch 仍单事务提交          |

修订不是“继续整段聊天重放”。Runtime 只携带完成修订所需的结构化状态：原请求、授权人反馈、上一版 summary、完整 Patch 提案和 canonical provenance。正文按 document ID 在本地重新读取；模型不能用 revision 请求扩大文档范围。若反馈确实要求新资料，调用方应明确拒绝当前提案并创建新的完整请求。

## 11. 运行状态与已知限制

界面把 Agent loop 嵌入当前 assistant 消息，以同一时间线交错显示模型 step、工具、Observation 后的重新判断、自动重试、授权等待和终态。模型 step 只显示可验证的行动摘要，不暴露隐藏思维链；工具参数摘要、结果预览和耗时可查看，完整审计详情可展开，运行中可停止。

C1.5-R 维护后，`ToolLoopAgent` 使用流式执行。Provider 明确返回的 reasoning delta 会在任务运行期间写入当前 assistant 消息的“思考中”区域，不再等终态一次性补齐；这只是 Provider 输出通道，不等同于应用内部隐藏推理。Runtime 会缓冲并屏蔽以 JSON 对象、数组或 fenced JSON 开头的协议内容，防止结构化提案被误显示成过程说明。

可观察 loop 按 `需求 -> 决策摘要 -> Tool running/completed（Observation）-> 下一轮决策 -> Summary` 实时追加到当前 assistant 消息。决策摘要在真实 tool call 开始前由工具名和已脱敏参数生成，表达“下一步做什么及目的”，不展示或伪造模型隐藏思维链；轮数随 step 事件实时更新，不再等终态回填。无工具的最后一轮明确记录“整理最终 summary”，并单独跟踪 summary 生成状态。

当前文档和选区在工具边界统一投影成 canonical Markdown：`get_current_document` 与 `get_selected_blocks` 只向模型返回文档元数据、稳定块标识和 Markdown，不返回 Tiptap JSON。编辑器与数据库内部仍保留 Tiptap 树用于结构编辑、版本校验和事务保存。

Agent 对话区左侧提供可折叠工作记录管理器，可切换项目、配置文档分组作业区，并直接选择、删除或新建对话。项目与历史记录由 SQLite 持久化。普通消息限制可见数量并自动回收定时器；最近一次 Agent 修改的撤销提示只控制 UI 可见性，9 秒后自动消失且可手动关闭，不会清除底层可撤销事务。

当前限制：

- Step/tool timeline 目前绑定当前 assistant 消息；历史消息持久化仍只保留最终正文与来源，完整过程事件持久化属于后续审计增强。

委托链使用 Context Bundle v2 冻结实际来源片段；`contentSnapshot` 与 document/block/revision 一起进入 snapshot hash，因此导出的 CLI envelope 可以重建受委托 Agent 当时看到的上下文。旧 v1 Bundle 继续可读，但缺失的冻结正文保持为 `null`，不会从当前文档反向猜测。

结果确认会生成并持久化版本化 `ConfirmationEnvelope`，统一包含 frozen input、acceptance criteria、委托 Context Bundle、外部 output、Artifact、Evidence 和确定性 checks，并保存独立 hash。Verifier 的自然语言 summary 只是显示层，不再是双方事实一致性的唯一记录。

- `/research` 已绑定 Research Mode、结构化结果与 Candidate 确认闭环。`/review` 已绑定 Review Mode、`review-result` v1 contract、Cognitive Session 和只读 issue UI；来源 revision/block 会在结果边界重新验证，失效来源产生 stale/outdated finding。Review run 不具备写提案权限，只有用户明确处理单项 issue 时才另起 `/edit` 运行进入现有 Patch 确认链。
- `/learn` 已绑定 Learning Mode、`learning-turn` v1 contract 与多轮 Cognitive Session。首次解释题由本地状态机生成且不请求 Provider；后续普通回复按 conversation 恢复 `waiting_user` session，将用户回复保存为 Attempt 后再更新理解状态、提示层级和下一问题。Learning 运行没有文档或正式知识写权限，临时候选理解记录只保存在结果消息中。
- 自动化有定义和运行队列，但没有后台无人值守模型调度器。
- MCP Prompts、Roots、Sampling、OAuth、旧 SSE 和跨任务长连接尚未开放。
- 真实 DeepSeek Provider、stdio/Streamable HTTP MCP、真实 CLI 外部进程和隔离数据恢复已通过 G0 smoke；Windows 干净安装包仍属于发布流程检查。
