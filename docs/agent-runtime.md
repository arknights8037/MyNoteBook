# Agent Runtime

## 设计目标

MyNoteBook 的 Agent 是一个受控的本地知识库协作者，不是拥有任意系统权限的自动化程序。它的职责是理解意图、读取许可范围内的文档上下文、提出可解释的结构化修改，并把最终写入权交给用户。

```text
用户意图
  -> 确定性工作流门禁（显式知识库任务必须检索并阅读）
  -> 候选块定位
  -> 系统提示词与来源上下文
  -> AI SDK ToolLoopAgent 原生 function calling
  -> 白名单只读工具执行 + SQLite 审计
  -> 工具结果回传模型（最多 6 轮）
  -> JSON response format + Zod 终态（commands、patches 或安全停止）
  -> 本地校验和 Diff
  -> 用户确认
  -> SQLite 原子写入 + 审计
  -> 受版本保护的撤销
```

## 不需要选区的修改

用户不必手动选择内容。写入模式会先判断是否存在真实选区；没有选区时，根据指令中的关键词从当前文档定位候选块。例如“将 P0 事项标记为完成”会优先把包含 `P0` 的块作为作用范围。模型只能操作候选块及其稳定 `blockId`。

候选定位没有把握时，系统不会把非结构化 Markdown 降级为整篇替换。它会要求模型给出安全的结构化 Patch。

## 系统提示词

系统提示词由两层组成：

1. 用户在设置页提供的基础角色提示词。
2. 运行时追加的模式契约。

Ask 模式是只读回答。Edit 和 Agent 模式明确告诉模型候选块、允许的命令、Patch schema、禁止操作和“只能提案、不得直接写入”的边界。

## 输出协议

写入模式必须返回一个 JSON 对象。Runtime 通过 AI SDK `Output.object` 请求 JSON response format，并在本地用 Zod 再次校验。模型可选择确定性命令或生成式 Patch：

```json
{
  "outcome": "proposal",
  "commands": [
    {
      "tool": "replace_text_by_regex",
      "pattern": "\\[ \\]",
      "replacement": "[x]",
      "flags": "g",
      "blockIds": ["stable-block-id"],
      "reason": "将待办标记为完成"
    }
  ],
  "patches": [],
  "finalAnswer": "已生成待确认修改。"
}
```

`outcome` 可为 `proposal`、`no_change` 或 `blocked`。后两种结果不得携带写操作，界面会把它们作为正常、可解释的任务结果，而不是协议错误。

`commands` 和 `patches` 应二选一。DeepSeek 的 JSON mode 只能保证语法，不保证字段严格匹配 schema，因此 Runtime 仅规范化可证明等价的常见偏差（`update -> replace`、`value -> after`、由 `blockId` 补全空目标数组、有效 Patch 存在时移除冗余 command），随后仍必须通过完整 Zod 校验。其他偏差进入一次受控修复，修复失败则安全终止，不生成写入。

## 工具循环

每次受控 Agent 运行会冻结一份 `ExecutionPolicy v1`，记录最大工具轮次、最大运行时间、失败预算、Token 预算、允许工具、风险等级、是否允许请求用户输入、是否允许提出写入和重试上限。原有 6 轮/5 分钟现在只是默认策略，不再是 Runtime 内不可追溯的硬编码行为。

模型调用前，`compileContextBundle()` 会把 scope、文档/块/revision、检索来源、权限快照、编译策略、目标 Provider/模型和 ExecutionPolicy 编译为不可变 `Context Bundle v1`，计算 SHA-256 snapshot hash，并通过 Rust transaction 关联到 `agent_tasks.context_bundle_id`。当前 Knowledge Object 尚未落地，因此 active rules、decisions 和 conflicts 保存为空数组，而不是伪造规则数据。

Agent 模式由 Vercel AI SDK `ToolLoopAgent` 执行真实的多轮循环。Provider 原生接收类型化工具 schema，AI SDK 负责保存工具消息、执行工具并把结果送入下一轮；最终输出在本地使用 Zod schema 校验为结构化 command/Patch。DeepSeek 当前不稳定支持“工具调用后再生成 `Output.object`”，因此最后一轮由 `prepareStep` 禁用工具并要求 JSON 终态，再做本地严格校验。

当用户自然语言明确要求“查知识库”“检索”“翻翻资料”等跨文档任务时，Runtime 不依赖模型自行遵守提示词：状态机会强制先调用 `search_documents`，有命中时再调用 `read_document`，之后才能进入终态生成。模型仍自主生成查询词、选择命中文档和提出修改。

- 原生工具调用：运行时校验工具白名单、Zod 参数、单工具调用次数和风险等级，执行后由 AI SDK 自动把结构化结果送回下一轮。
- `commands` / `patches`：结束工具循环，进入本地校验、Diff 和用户确认。

只读工具可以在循环中立即执行。写工具即使已注册，也不能在循环中直接改变编辑器或数据库；模型必须把写入意图转换成最终 command/Patch。循环最多 6 轮，最多容忍 2 次工具失败，单任务最长 5 分钟。每次调用无论成功或失败都会写入 `agent_tool_calls`。

如果模型在工具返回后只用自然语言声称“已完成”，运行时不会结束任务或写入文档，而是把协议错误反馈给模型并要求在剩余轮次内修复为结构化 JSON。

运行过程通过统一进度事件向界面报告“正在检索知识库”“正在阅读相关资料”“正在整理可确认的修改”等用户可理解的阶段。失败消息保留原任务并支持重试；重试会重新读取当前 revision 和上下文，不复用旧 Patch。

运行条实时展示当前阶段、累计耗时和停止入口。工具开始时立即加入展开式调用列表，结束后以同一调用 ID 更新成功或失败状态，并展示工具名称、参数摘要、结果摘要、错误和单次耗时；最近一次 Agent 完成后保留该轨迹，清空对话时一并清除。模型推理原文不作为运行审计展示。

`search_documents`、`read_document` 和 `execute_shell` 由 Rust Rig `ToolSet` 注册并通过 Tauri 调用；当前编辑器、选区、大纲和正则定位保留在 TS 进程内，因为这些数据只存在于 Tiptap 会话。两端共享同一工具名称和数据库审计记录，不运行第二套模型循环。

## 已接入工具

| 工具                        | 权限     | 行为                                                           |
| --------------------------- | -------- | -------------------------------------------------------------- |
| `get_current_document`      | 只读     | 读取当前文档、revision 和稳定块。                              |
| `get_selected_blocks`       | 只读     | 读取真实选区；没有选区时返回空数组。                           |
| `get_document_outline`      | 只读     | 返回当前文档标题块及其 block id。                              |
| `search_documents`          | 只读     | 通过 SQLite FTS5 搜索知识库，返回文档 ID、标题和片段。         |
| `read_document`             | 只读     | 按文档 ID 读取正文、标签和 revision，并限制返回长度。          |
| `find_blocks_by_regex`      | 只读     | 用受限正则定位当前文档块。                                     |
| `execute_shell`             | 只读     | 执行白名单内的 Windows 查询或本机工具只读子命令。              |
| `inspect_environment_paths` | 只读     | 拆分 PATH、PATHEXT、PSModulePath 并检查路径是否存在。          |
| `discover_local_tools`      | 只读     | 在 PATH 中发现常见或指定工具，不执行程序。                     |
| `get_system_info`           | 只读     | 读取操作系统、架构、CPU 数和当前工作目录。                     |
| `replace_text_by_regex`     | 写入提案 | 在候选块中本地执行受限正则，展开为逐块 Patch，进入 Diff 确认。 |
| `replace_block`             | 写入提案 | 将允许范围内的单个稳定块展开为 replace Patch。                 |
| `insert_blocks`             | 写入提案 | 在允许范围内的锚点块前后生成插入 Patch。                       |
| `create_document`           | 写入提案 | 生成独立的新文档提案，经确认后由 Rust 原子事务创建。           |

正则限制为最多 240 个字符，只接受 `g`、`i`、`m` flags；无效表达式、过长替换内容和无命中目标都会失败，不产生写入。

`execute_shell` 不接受 PowerShell 脚本文本。PowerShell 仅开放 `Get-Process`、`Get-Service`、`Get-Command` 和 `Get-Date` 的结构化查询；本机工具仅开放 `git` 的只读子命令、`rg` 当前工作目录搜索、`where.exe` 定位，以及 Node、pnpm、npm、Python、Cargo、rustc 的版本查询。Agent 可按任务指定 `timeoutMs`（1–30 秒）和 `maxOutputChars`（4,096–65,536），默认分别为 10 秒和 32,768 字符。Rust 端再次校验命令和参数，拒绝绝对路径与父目录跳转，所有调用都会记录到 `agent_tool_calls`。

环境工具不会返回完整环境变量表，避免把 API Key、Token 等敏感值送入模型。`inspect_environment_paths` 只公开 PATH、PATHEXT 和 PSModulePath；`discover_local_tools` 只用安全工具名扫描 PATH，最多返回每个工具的三个命中路径，并且不会执行发现的程序。

三个结构化写命令都由 `AgentCommandService` 在本地展开。块命令只能引用本次候选范围内的 block id；`create_document` 必须独占一批提案，只能创建在当前文档下或知识库根目录。模型不能在工具循环中直接执行这些写操作。

### 外部 MCP 工具

Agent 运行开始时会连接用户已启用的 MCP 服务并读取 `tools/list`。每个外部工具根据服务 ID 和工具名生成 provider-safe 的 `mcp__...` 运行时名称，输入 schema 直接采用 MCP 返回的 JSON Schema，并与内置工具一起交给 AI SDK 原生 function calling。

MCP annotations 明确声明 `readOnlyHint: true` 的工具按只读工具执行；其他或未声明风险的工具默认视为可能产生外部副作用，每次调用前通过 `request_authorizer_input` 等待授权人确认。MCP 调用结果只作为模型观察值，不会绕过本地 Patch/Diff 写入门禁。具体导入格式和传输边界见 [MCP Client](mcp-client.md)。

## Patch 与确认

每个 Patch 包含文档 ID、块 ID、目标块、预期 revision、修改前后内容、操作和原因。应用前会校验：

- 文档与 Patch 的 revision 一致；
- 目标块仍存在，且当前文本与 `before` 一致；
- 目标不重复、替换范围连续；
- 内容非空且操作受支持。

用户可以逐项接受、编辑 `after`、全部拒绝或接受全部。Patch 草案保存、确认写入、拒绝和撤销都由 Rust 端在单个 SQLx 连接事务中完成，避免连接池把 `BEGIN` 与后续语句分配到不同连接。模型流式输出从不直接修改编辑器或数据库。

Rust apply 边界会再次校验 task 必须处于 `waiting_confirmation`、目标文档与任务一致、决策覆盖整套 proposed Patch、revision 匹配、目标块仍存在且 `before` 未变化，并检查接受后的可见文本确实存在于结果 Tiptap 投影。最终 `plain_text` 和 `blocks` 均由 Rust 从结果 JSON 重新生成，不信任前端传入的派生文本。

## Skill 与运行 provenance

系统提示词只注入已启用 Skill 的 ID、描述和入口摘要，不再全量拼接所有 `SKILL.md`。Agent 判断任务匹配后使用 `read_skill_file` 按需读取正文。运行记录保存当时启用的 Skill ID/版本、Provider、实际模型参数和被忽略参数。

新文档提案使用独立的创建事务。撤销时仅当新文档仍为 revision 1 才允许删除；用户后续编辑过的新文档不会被撤销覆盖。

来源链接可以携带稳定 `blockId`。页面切换完成后，编辑器通过公开的 `revealBlock` 命令滚动并短暂高亮来源块；旧的文档级链接保持兼容。

## 审计与撤销

`agent_tasks`、`agent_patches`、`agent_task_sources`、`agent_confirmations`、`agent_document_transactions` 和 `agent_tool_calls` 保存任务生命周期、来源、确认事件和写入快照。

撤销只会在文档 revision 仍等于该 Agent 事务产生的 revision 时执行。若其后已有人工保存，撤销会拒绝，避免覆盖用户的新内容。

应用启动和页面切换时会从审计表恢复待确认 Patch 与最近一笔仍满足 revision 条件的事务。上次退出时尚处于 `pending` 或 `running` 的任务会在启动恢复阶段标记为中断失败；`waiting_confirmation` 提案保持可审阅，避免异常退出后丢失用户尚未处理的 Diff。
