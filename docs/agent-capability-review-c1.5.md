# Agent 能力复核与收口记录

本文最初用于 C1.5-R 的能力审查。下文按 2026-07-29 主干代码重新核对，保留问题的关闭状态和仍存在的设计债，不再把历史实现阶段描述成当前状态。

## 当前结论

当前 Agent 已不是一次性批处理循环。一次运行具有可持久化的 lifecycle、plan、run events、tool calls 和 timeline；同一请求还可通过 revision continuation 携带上一版摘要、Patch、canonical provenance 与授权反馈。规范工具审计继续保存在 `agent_tool_calls`，消息中的运行投影用于恢复和 UI 展示。

工具目录目前包含 25 个内置工具。模型侧仍由 AI SDK `ToolLoopAgent` 驱动；认知模式和普通 Ask/Edit/Agent 共用这一 Runtime，没有第二套循环。

## 原 P1 问题复核

| 问题                              | 当前状态 | 代码中的处理                                                                                             |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| Provider 可见工具未按最小权限裁剪 | 已关闭   | `allowedTools` 同时约束 ToolSet 与 `activeTools`；intent、认知模式和 continuation 在运行前编译稳定工具名 |
| 缺少统一运行时间线                | 已关闭   | step start/end、工具生命周期、重试、授权等待和终态事件投影到同一 timeline，并随消息快照持久化            |
| 重试策略没有真正执行              | 已关闭   | `maxRetries` 传给 Provider；只有显式 `retryable` 的幂等只读工具允许有界重试，写入和未知副作用工具不重试  |
| 失败工具可按相同参数反复调用      | 已关闭   | 相同工具和规范化参数的失败调用会被抑制；成功的相同 `read_document` 在单次运行内复用 Observation          |

这组关闭不意味着可以放松安全边界：工具执行仍必须先写 `running` 审计，取消仍需等待已开始调用写入终态。重新核对后发现 MCP 当前实际使用 `requiresConfirmation = !serverTrusted`，`readOnlyHint` 没有参与免确认判定；因此“信任与只读同时满足”仍是目标规则，不是已经落实的现状，对应 P0 修复见 [路线图 Phase 0](roadmap.md#4-phase-0安全与基础契约)。

## 原 P2 问题复核

### P2-1：工具契约仍未完全单源化 — 部分完成

工具名称、描述、风险、标签和展示标题已经集中在 `AgentToolRegistry`，模型可见描述从该目录取得。前端 Zod 输入 schema、Provider JSON Schema、Rust 原生命令参数与部分展示结构仍分别维护，因此字段变化仍存在漂移风险。

后续应增加生成或快照比对，不应把 Rust 的独立校验删除；Rust schema 是可信执行边界，不只是重复代码。

### P2-2：终态写入协议重叠 — 仍存在

普通运行仍兼容 `commands`、`patches` 和工具驱动的 `submit_document_edits`。认知运行已经使用独立版本化 Output Contract，但非认知写入尚未收敛到唯一长期协议。当前多层校验使其安全可用，这仍是维护复杂度而不是已关闭问题。

### P2-3：审计截断可能产生非法 JSON — 已关闭

大参数或结果通过版本化截断 envelope 保存，至少包含 `version`、`truncated` 和 `originalChars`；持久化内容仍是合法 JSON，可被诊断工具稳定解析。

### P2-4：工具结果展示依赖字符串分支 — 部分完成

文档读取、检索等核心结果已有 typed presentation 和专用摘要，但展示层尚未完全由工具目录驱动。新增工具时仍需同时检查运行注册、审计脱敏、展示摘要和测试。

## 读取行为专项复核

`read_document` 当前支持 `cursor`、`maxChars` 和 `blockIds`，结果明确返回：

- 文档 revision、分页位置、`truncated` 与 `nextCursor`。
- 实际返回的块范围、字符预算和稳定 block provenance。
- 面向阅读的 `plainText` 摘要与面向结构修改的 canonical Markdown。

同一次运行中，工具名和规范化参数相同且上次成功的读取会直接复用上一条 Observation，不再次访问文件。UI 会标明读取的块范围、预算和是否截断，因此可以区分“读取某些块”“分页读取”和“读取完整文档”。

分页预算是软目标而不是破坏 canonical 块的硬切割线。如果下一个完整块超过 `maxChars`，Runtime 可以返回该完整块，但仍受 65,536 字符的单次安全上限约束。这样避免模型为了拿到一个不可拆分的大块不断放大预算重读。

结构化块不能用纯文本投影写回。尤其是 `tableBlock`：TSV `plainText` 只用于阅读和检索，修改必须基于 canonical Markdown pipe table；普通段落、空格对齐表格和真正的结构 no-op 会在工具入口或 Rust 保存边界被拒绝。

## 长运行可观测性

消息快照会保存运行生命周期、事件、工具调用和时间线，使应用重启后仍能恢复最近运行卡片。为了控制快照大小，这些 UI 数组有界；完整、规范的逐工具审计仍以数据库表为准。

因此仍有一个明确后续项：提供按 task/run 聚合数据库审计和消息投影的诊断入口，展示缓存复用、分页游标、重试原因、授权等待、finish reason 与 token usage。该入口只读，不应改变 Runtime 或重新执行工具。

## 当前安全与验收基线

- 内置工具总数：25；认知模式只能收紧基础 ExecutionPolicy，不能扩大权限。
- `read_document` 的成功同参读取可复用，失败同参调用被抑制，分页和块范围可见。
- 写入工具只捕获提案；文档实际修改仍需 Diff、确认、revision 校验和 Rust transaction。
- continuation 只能在上一提案范围内修订，不能重新搜索或借反馈扩大文档权限。
- timeline 不展示隐藏思维链，只展示可验证的运行、工具、授权和结果事件。
- 审计参数、结果、Provider 错误和日志继续经过凭据脱敏。
- MCP 当前只按 Server trust 决定是否逐次确认；在 `trusted && readOnly` 目标规则落实并通过测试前，不得把该项标记为已关闭。

未完成项统一进入 [后续开发路线图](roadmap.md)：工具契约单源化、写入协议减法和完整运行诊断入口。
