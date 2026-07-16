# Agent 能力 Review（C1.5）

评审日期：2026-07-15  
评审基线：`docs/roadmap.md` 中已完成的 C1.5 Runtime 接线与自托管修改门禁，以及当前工作树中的未提交 Runtime 改动。  
评审范围：工具复杂度、工具定义一致性、流程稳定性、内容获取格式、自动重试、渐进式任务处理与 UI 过程展示。

维护状态：**已按 C1.5-R 实施（2026-07-15）**。本报告保留原始发现作为设计依据；对应修复包括 step/tool 交错时间线、按策略裁剪 Provider 工具、Provider 与幂等只读工具重试接线、重复失败签名门禁、分页文档 Observation、合法截断审计 envelope，以及由 `AgentToolRegistry` 统一提供模型可见的内置工具说明。完整 timeline 的跨历史消息持久化仍列为后续审计增强。

## 结论

C1.5 的受控写入闭环已经成立：工具调用、Patch、确认和事务边界具备可追溯性，模型不能直接写正文。但 Agent 的“工作过程产品化”尚未完成，当前实现更接近安全的批处理工具循环，而不是用户可理解、可恢复、可诊断的渐进式 Agent。

本次评审发现 4 项 P1、4 项 P2。最影响当前体验和稳定性的根因是：

1. `ToolLoopAgent` 使用一次性 `generate()`；运行期间只上报工具开始/结束，模型轮次与 Observation 后的重新判断不会进入 UI，所以界面必然表现为“执行、执行、执行、最后汇总”。
2. `ExecutionPolicy.allowedTools` 只在工具被调用后校验，没有裁剪实际传给模型的工具集合。受限运行仍看见全部 21 个内置工具，容易产生无效调用和额外轮次。
3. `maxRetries` 虽然进入了 ExecutionPolicy 和文档，但没有传给 AI SDK；实际使用的是 SDK 默认重试值 2，策略配置不生效，重试过程也不可观察。
4. `read_document` 同时把整篇 `plainText`、每块 `plainText`、完整 `contentJson` 和前端补出的 `markdown` 返回给模型。内容被重复携带，块数组没有总字符预算或分页，容易显著放大上下文。

原始评审结论是：C1.5 的安全门禁可以保持“完成”，但不应把当时的 Agent 过程展示视为完成；因此提出进入 C2 前增加 C1.5-R 稳定性收口批次。该批次现已按上方“维护状态”实施。

## 发现明细

### P1-1：缺少真正交错的模型步骤事件

证据：

- `src/services/AiSdkAgentRuntime.ts` 仅在调用 `agent.generate()` 前发送一次 `planning`，工具包装器发送 `tool_running` / `tool_completed`，结束后发送 `finalizing`。
- `collectReasoningText()` 在整个 `generate()` 返回后才汇总所有 step reasoning，再通过 `onDelta` 一次性写入消息。
- `AgentProgressUpdate` 只有 `planning | tool_running | tool_completed | finalizing`，没有 step start、observation、replanning 或 retry。
- `AiChatPanel.vue` 把所有工具放在一个列表中，当前 phase 固定显示在列表尾部；数据结构本身无法表达“判断 → 工具 → 观察 → 再判断 → 工具”的时间顺序。

影响：

- 用户无法知道 Agent 为什么继续调用下一个工具，也无法分辨正在等待模型、处理 Observation、重试 Provider，还是已经卡住。
- 长任务在两个工具调用之间可能长时间没有可见变化。
- 文档中“按时间显示工具和当前阶段”的说法只对工具生命周期成立，不覆盖模型步骤。

建议：

- 新增不可变的 `AgentTimelineEvent[]`，至少支持 `run_started`、`step_started`、`tool_started`、`tool_completed`、`observation_ready`、`step_completed`、`retry_scheduled`、`finalizing` 和终态。
- 使用当前 AI SDK 已提供的 `onStepStart` / `onStepEnd` 接入每次模型调用；工具事件继续沿用现有审计 ID。
- UI 使用单一时间线交错渲染 step 与 tool，而不是“工具列表 + 当前 phase”。
- 展示简洁的行动依据和 Observation 摘要，不展示隐藏思维链。推荐文案形态为“已读取 2 篇候选资料，正在比较 revision 与目标块”，而不是原始 reasoning。
- 进度事件应绑定 assistant message/task 并持久化；不能继续只保留最近一次 Runtime 状态。

### P1-2：工具可见范围与 ExecutionPolicy 不一致

证据：

- `AiSdkAgentRuntime.ts` 无条件构造 21 个内置工具，再追加 MCP 工具。
- `policy.allowedTools` 只在 `executeTracked()` 和 `captureProposal()` 内检查，即模型已经选择并发起调用之后才拒绝。
- continuation 在 `useAgentRun.ts` 中把 `allowedTools` 收紧为 `['submit_document_edits']`，但模型仍收到全部工具定义。
- System Prompt 固定列出完整工具目录，测试也明确要求每个 registry 工具都出现在 Prompt 中。

影响：

- 受限修订、只读认知运行和按 tag 编译的运行仍会被无权限工具干扰。
- 模型调用无权限工具会消耗 step、token 和失败额度；界面会显示一次本可避免的失败。
- “只有 Runtime 实际提供的工具才可调用”与实际行为不一致。

建议：

- 在创建 Agent 前根据 `allowedTools` 生成 filtered ToolSet，并同时设置 AI SDK `activeTools`。
- MCP 的 `mcp:*` 只展开成本次已发现且通过策略交集的运行时名称。
- Prompt 的工具目录由 filtered ToolSet 生成，不再硬编码全量名称。
- 增加测试：continuation 只向 Provider 暴露 `submit_document_edits`；只读 run 不暴露任何写提案工具；denied tag 对应工具既不可见也不可执行。

### P1-3：自动重试策略名义存在、实际未接线

证据：

- `ExecutionPolicy` 定义、默认和规范化了 `maxRetries`，`docs/agent-runtime.md` 也将它列为正式策略字段。
- `new ToolLoopAgent({...})` 没有传入 `maxRetries`。
- 当前安装的 AI SDK 在未传值时默认执行 2 次指数退避重试，所以把策略改成 0 或 8 都不会改变 Provider 请求行为。
- `AgentToolExecutionResult` 只有 `ok/value/error`，没有错误码、`retryable`、attempt 或 retry-after，Runtime 无法安全地自动重试只读工具。
- Prompt 要求模型“修正一次”，但 Runtime 只累计全局失败数；相同参数的失败调用没有签名去重或单次纠错门禁。

影响：

- 配置和审计无法真实描述 Provider 重试行为。
- 退避期间 UI 没有事件，用户只看到阶段停滞。
- 对工具错误只能依赖模型自律；同一个错误可重复发生，直到工具调用上限或全局失败上限。

建议：

- 把 `policy.maxRetries` 明确传给 AI SDK；仅让 SDK 重试可判定为瞬态的 Provider/网络错误。
- 将工具错误统一为 `{ code, message, retryable, retryAfterMs?, scope }`。只有幂等只读工具且 `retryable=true` 才允许 Runtime 自动重试；写提案、草稿和未知 MCP 工具不自动重试。
- 每次重试产生 `retry_scheduled` / `retry_started` 事件，记录 attempt、原因和延迟；最终 result 保存实际 attempt 数。
- 对“模型修正调用”和“Runtime 自动重试”使用不同计数器。记录失败调用签名，禁止在未改变参数或前置状态时原样重复。
- 将 `failures > maxToolFailures` 改为与字段语义一致的门禁并补边界测试；当前写法会在配置 6 时容许第 7 次失败发生后才终止。

### P1-4：`read_document` Observation 重复且无总预算

证据：

- Rust 返回最多 12,000 字符的整篇 `plainText`，同时返回所有 canonical blocks；每个 block 含完整 `plainText` 和 `contentJson`。
- 前端 `enrichReadDocumentResult()` 又为每个有 `contentJson` 的 block 追加 `markdown`。
- blocks 没有总字符数、块数量分页、按范围读取或 continuation cursor。
- C1.5 实际纵向记录中一次任务 input 达 84,076 tokens；虽然不全由该工具造成，但与重复携带多份正文的结构相符。

影响：

- 同一内容通常以整篇文本、块文本、JSON 树和 Markdown 四种投影重复进入上下文。
- 大文档会挤压模型用于判断和最终提案的 token，增加 length 终止、延迟和成本。
- 工具参数和 Observation 过大，使工具 trace 难以阅读。

建议：

- 将模型 Observation 与 Runtime 内部 provenance 分离。模型默认只收到文档元数据、块 ID/type/index 和 canonical Markdown；revision、hash 和必要结构校验数据保存在本地 provenance store。
- `plainText` 仅用于检索摘要；不要在已返回完整块 Markdown 时再次返回整篇正文。
- 增加 `range` / `blockIds` / `cursor` / `maxChars`，先读 outline 或摘要，再按需取块。
- 对表格等结构块返回完整 Markdown；仅在本地校验确实需要时保留 `contentJson`，不默认发送给模型。
- 每个 Observation 返回 `truncated`、`nextCursor`、`returnedBlocks` 和 `estimatedChars`，禁止静默截断。

### P2-1：工具契约存在四套定义源

当前同一工具的契约分散在：

1. `AgentToolRegistry.ts`：名称、简短描述、risk、tags、最大调用数。
2. `AiSdkAgentRuntime.ts`：模型可见 description 和 Zod schema。
3. `agent_tools.rs`：原生工具 description、JSON Schema、参数校验和实现。
4. `AiSystemPrompt.ts`：手写工具目录、参数规则和使用纪律。

具体漂移示例：`read_document` 的 AI SDK 描述只说返回正文、标签和 revision，System Prompt 和文档却要求依赖 blocks、`contentJson` 和 `markdown`；registry 和 Rust 描述又更简略。当前测试只检查“Prompt 包含工具名”，没有比较 schema、必填项、范围和输出能力。

建议建立单一 TypeScript ToolCatalog，至少派生 provider tool、policy registry、UI label/preview 和 Prompt catalog；Rust 原生 schema 保留独立安全校验，但增加契约快照/兼容测试，比较名称、required、enum、min/max 与输出 envelope 版本。

### P2-2：模型同时面对重叠工具和新旧两套写入协议

当前共 21 个内置工具，其中读取当前文档相关工具 4 个，环境诊断相关工具 4 个，写入提案工具 6 个。复杂写入已经收敛到 `submit_document_edits`，但 Prompt 和最终 `agentOutputSchema` 仍保留 `commands` / `patches` 旧协议，并继续教模型何时直接输出 patches。

这增加了工具选择歧义和 schema 负担。建议按 intent/stage 暴露小型工具包，并让写入运行只保留两类模型概念：简单单目标 edit 和统一的 `submit_document_edits`；legacy command/Patch 只作为 Runtime 内部兼容格式，不再写入生产 Prompt。

### P2-3：审计字段名为 JSON，但截断后不再是合法 JSON

`safeAuditJson()` 先序列化，再直接按 24,000 字符切片并追加省略号。较大的 arguments/result 因此会作为无效 JSON 写入 `arguments_json` / `result_json`。UI 的 `parseToolPayload()` 只能捕获异常后退化成原始字符串，随后再截成 8,000 字符显示。

建议持久化合法的版本化 envelope，例如 `{ version, truncated, originalChars, preview, payload }`；需要截断时截断字符串字段或数组项，而不是切断最终 JSON。完整大结果若确有审计需要，应单独存 blob/hash，timeline 只保存摘要与引用。

### P2-4：工具结果 UI 是通用 JSON 查看器，不是任务过程

当前摘要只识别少量通用集合字段，详细内容统一以 `<pre>` 展示最多 8,000 字符。对 `read_document`、搜索、Shell、提案和 MCP 没有稳定的类型化展示，也没有明确标记“这是 Observation，不是 Agent 结论”。

建议在 ToolCatalog 中定义 `summarizeInput`、`summarizeOutput` 和敏感字段策略；UI 默认展示目标、数量、截断状态和关键结果，原始审计 JSON 放到二级详情。模型步骤摘要与工具 Observation 应在同一 timeline 中相邻显示。

## 建议的 C1.5-R 实施顺序

### R1：可见、可信的渐进式循环

- 引入 timeline event 模型和 task/message 持久化。
- 接入 `onStepStart` / `onStepEnd`，交错展示 step、tool、observation 和 finalizing。
- 不显示隐藏思维链，只显示可验证的简洁行动摘要。

### R2：策略与重试真正接线

- 只向模型暴露 `allowedTools` 交集。
- 传入 `maxRetries`，增加 retry 事件与 attempt 审计。
- 为工具错误增加 code/retryable，并阻止相同失败调用原样循环。

### R3：工具契约与 Observation 收敛

- 建立单一 ToolCatalog 与 Rust 契约兼容测试。
- 精简写入工具和 legacy Prompt。
- 为 `read_document` 增加范围读取、分页与字符预算，分离模型 payload 和本地 provenance。
- 改为合法、版本化、可截断的审计 envelope。

## 验收标准

1. 一个执行 `search → read → submit` 的任务在 UI 中至少显示：第 1 轮判断、搜索开始/结果、Observation 摘要、第 2 轮判断、读取开始/结果、再次判断、提案工具、终态；顺序与真实事件一致。
2. 任意两个相邻工具之间，若发生新的模型 step，timeline 必须出现对应 step 事件；超过 2 秒没有事件时显示当前等待对象与耗时。
3. continuation 的 Provider 请求中只能看到 `submit_document_edits`；调用其他工具不能仅依赖执行后拒绝。
4. `maxRetries=0` 时 Provider 不自动重试；`maxRetries=2` 时仅对可重试错误最多重试 2 次，三次 attempt 均可审计并可取消。
5. 同一失败工具名和相同规范化参数不能由模型原样重复超过一次；改变参数后的纠错与 Runtime 瞬态重试分别计数。
6. 读取超大文档时，单次 Observation 不超过配置字符预算，返回合法 `truncated/nextCursor`；不得同时重复返回整篇 plain text、全部 JSON 和全部 Markdown。
7. 所有持久化 `arguments_json` / `result_json` 都可被 `JSON.parse`；截断后仍满足版本化 envelope schema。
8. 契约测试能在 TypeScript/Rust 的 enum、必填字段或范围漂移时失败。

## 本轮不建议做的事

- 不把原始隐藏 reasoning 当作进度日志直接暴露给用户。
- 不对写入提案、草稿创建或未知 MCP 副作用工具做通用自动重试。
- 不通过继续堆叠 Prompt 规则来约束重复调用；策略裁剪、错误类型和调用签名门禁应由 Runtime 实现。
- 不在 C2 Research UI 之上继续复用“工具列表 + footer phase”的状态模型；先完成通用 timeline，再让 Research 结果挂接其上。
