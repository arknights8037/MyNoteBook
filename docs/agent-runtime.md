# Agent Runtime 与工具协议

MyNoteBook 的 Agent 是受控的本地知识协作者。它可以读取许可范围内的文档、知识和外部工具结果，生成回答或结构化修改提案；它不能绕过本地权限、确认与可信写入边界。

## 1. 入口与执行流程

`useAgentRun` 负责一次交互式运行的前端编排，`runAgentToolLoop` 将 Agent 模式交给 `AiSdkAgentRuntime` 的 AI SDK `ToolLoopAgent`。

```text
用户输入 / Slash Command
  -> 冻结文档、选区、Provider 和模式
  -> 创建 AgentTask
  -> 编译 Skill 摘要、Context Bundle 和 ExecutionPolicy
  -> ToolLoopAgent：模型 -> Tool -> Observation -> 下一轮
  -> 本地校验最终结构化输出
  -> 回答，或 command/Patch 提案
  -> Diff / 用户确认 / Rust transaction
```

Ask 使用普通流式 Markdown 请求；Edit 生成受控 Patch；Agent 使用真实工具循环。Slash Command 只选择 intent 和策略，不包含独立业务 Runtime。

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

当前通用默认值为最多 32 轮、10 分钟、6 次工具失败和 2 次重试；标准化边界允许 1–64 轮、1 秒–30 分钟和 0–12 次工具失败。具体任务、intent 或 Cognitive Mode 可以收紧这些值，但不能绕过 Runtime 检查。

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

写入提案工具成功只代表提案被 Runtime 捕获，并不代表文档已经修改。兼容模型若无法在工具调用后可靠使用 provider structured output，Runtime 会要求最终 JSON 并执行本地严格解析；结构不合法时不产生写入。

旧运行默认使用文档 command/Patch 契约。Runtime 也可注入版本化 `AgentOutputContract<T>`：Prompt 加入 contract 指令，终态从正文或 reasoning 通道提取 JSON 并在本地严格校验；无效结构不会进入候选或写入。当前测试认知 contract 与旧协议共用同一 `ToolLoopAgent`，没有第二套模型循环。

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

| 工具                        | 风险           | 行为                               |
| --------------------------- | -------------- | ---------------------------------- |
| `get_current_document`      | read           | 当前文档、revision 和稳定块        |
| `get_selected_blocks`       | read           | 用户真实选中的块                   |
| `get_document_outline`      | read           | 标题大纲与 block ID                |
| `search_documents`          | read           | SQLite FTS5 检索                   |
| `list_document_groups`      | read           | 获取真实分组 ID 与子项数量         |
| `read_document`             | read           | 按 ID 读取正文、标签和 revision    |
| `find_blocks_by_regex`      | read           | Rust 线性时间正则定位块            |
| `read_skill_file`           | read           | 读取已启用 Skill 内的受限相对路径  |
| `request_authorizer_input`  | read           | 暂停并等待授权人选择或文本         |
| `execute_shell`             | read           | 白名单 Windows/本机只读命令        |
| `inspect_environment_paths` | read           | 有界读取 PATH/PATHEXT/PSModulePath |
| `discover_local_tools`      | read           | 发现安全名称的本机工具             |
| `get_system_info`           | read           | 系统、架构、CPU 和工作目录         |
| `create_automation_draft`   | draft          | 授权后创建停用自动化草稿           |
| `create_skill_draft`        | draft          | 授权后创建停用 Skill 草稿          |
| `replace_text_by_regex`     | write proposal | Rust 正则生成逐块替换提案          |
| `replace_block`             | write proposal | 完整替换允许范围内的块             |
| `insert_blocks`             | write proposal | 在稳定锚点附近插入内容             |
| `create_document`           | write proposal | 创建新文档提案                     |
| `create_group`              | write proposal | 创建分组及可选初始文档提案         |
| `propose_document_patches`  | write proposal | 提交一批复杂 Patch                 |

Rust 正则引擎限制 pattern、flags、块数量、replacement 和编译内存，保证线性时间；不支持回溯引用或 look-around。查找和替换都不在 WebView 主线程构造模型提供的 JavaScript `RegExp`。

`execute_shell` 不接收脚本文本，只允许结构化白名单：PowerShell 查询、Git 只读子命令、`rg` 当前工作区搜索、`where.exe` 和开发工具版本查询。Rust 再次校验参数、路径、超时和输出上限。

## 7. MCP、Skills 与外部边界

Agent 运行开始时对已启用 MCP Server 执行 `tools/list`，将 JSON Schema 转换成 provider-safe 的 `mcp__...` 工具。服务只有同时满足“本地标记 trusted”和工具声明 `readOnlyHint: true` 才免逐次授权；其他工具在调用前等待授权人确认。

MCP 返回值只作为不可信 Observation。它不能绕过 Patch/Diff，也不能直接更新 Knowledge Object。Tools、Resources、只读 MCP Server 与 Delegation 的完整边界见 [MCP Client](mcp-client.md)。

## 8. Patch、确认与撤销

command 先由本地 `AgentCommandService` 展开为 Patch。每个 Patch 保存 task、document、block、target blocks、expected revision、before/after、operation 和 reason。

用户可逐项接受、编辑 `after`、拒绝或接受全部。Rust apply 边界重新校验：

- task 和 Patch set 状态正确。
- Patch 属于目标 task/document。
- revision、block、before 和目标范围未变化。
- 接受决策覆盖整套提案。
- 结果 Tiptap JSON 可验证，投影包含接受后的可见文本。

最终 `plain_text`、`blocks` 和 FTS 由 Rust Document Core 重新生成。撤销只有在 resulting revision 仍未被后续人工编辑改变时执行；新文档只有仍为 revision 1 时才可由 Agent 撤销删除。

## 9. 运行状态与已知限制

界面把 Agent loop 嵌入当前 assistant 消息，按时间显示工具、参数摘要、结果预览、耗时和当前阶段。完整参数/结果可展开，运行中可停止。

当前限制：

- Tool trace 只保留最近一次 Runtime 状态，尚未绑定和持久化到每条历史消息。
- `/research`、`/review` 仍只是 intent 策略；Cognitive Session 和结构化 contract 已落地，但绑定命令、结果 UI 与候选确认属于后续阶段。
- 自动化有定义和运行队列，但没有后台无人值守模型调度器。
- MCP Prompts、Roots、Sampling、OAuth、旧 SSE 和跨任务长连接尚未开放。
- 真实 DeepSeek Provider、stdio/Streamable HTTP MCP、真实 CLI 外部进程和隔离数据恢复已通过 G0 smoke；Windows 干净安装包仍属于发布流程检查。
