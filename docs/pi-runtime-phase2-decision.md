# Phase 2 PI Runtime 原型与决策记录

日期：2026-07-29

## 结论

Phase 2 选择路线图决策门的 **选项 1：保留 AI SDK**。Phase 3 首次把 Runtime 移出 WebView 时，继续使用已经通过生产行为验证的 `AiSdkAgentRuntimeAdapter`；PI 原型保留为可替换实现和回归夹具，但不接入生产 Agent、Ask/Edit 或 Cognitive 模式。

这不是对 PI 可行性的否定。纵向原型证明 PI 能消费同一 `AgentRunRequest v1` 和 Domain Tool Manifest，也能映射工具、事件、取消和 Patch 提案。当前不切换的原因是 PI 尚未在本项目的真实 Provider/Tauri 代理、授权等待和 structured-output repair 上达到现有 AI SDK 的证据强度；在迁出 WebView的同时更换模型 Runtime 会把两个高风险变量叠加。

## 原型范围

新增私有 Node workspace package `@mynotebook/pi-agent-worker`，使用：

- `@earendil-works/pi-agent-core@0.82.1`
- `@earendil-works/pi-ai@0.82.1`
- Node `>=22.19.0`（包的上游最低版本；当前开发机为 Node 24）

路线图原先引用的 `@mariozechner/pi-agent-core` / `pi-ai` 在 npm 已标记弃用，当前维护作用域为 `@earendil-works/*`。版本固定，不使用浮动范围。

原型链路为：

```text
AgentRunRequest v1
→ PiAgentRuntimePrototype
→ frozen Domain Tool Manifest
→ search_documents
→ read_document
→ trusted + readOnly MCP tool
→ submit_document_edits capture
→ existing AgentPatchProposal shape
→ existing Diff / revision validation / Rust transaction（保持原生产链路）
```

Node 不导入数据库实现，不连接 SQLite。读取工具和 MCP 经 `PiToolRpcPort` 调用 Rust；`StdioPiToolRpcClient` 将 invoke/progress/result/cancel 映射为 NDJSON，并在取消后等待 Rust 返回工具终态。完整 Worker 进程启动、heartbeat、run RPC 和自包含打包仍属于 Phase 3。

`submit_document_edits` 不通过工具 RPC 写库。PI Adapter 只验证、捕获并转换为现有 `AgentPatchProposal` 字段，实际文档修改仍必须经过 Diff、人工 mutation approval、revision 校验和 Rust transaction。

## 同场景对比

| 维度                          | AI SDK 生产 Adapter                                          | PI Phase 2 原型                                        | 结论                     |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ | ------------------------ |
| Runtime Port / Request        | 已接生产 UI                                                  | 消费同一共享 contracts package                         | 等价                     |
| Tool Catalog                  | Domain Tool Manifest → AI SDK ToolSet                        | 同一 manifest snapshot → PiToolAdapter                 | 没有第二套 Registry      |
| Tool ID                       | 内部 ID 与 Provider ID 分离                                  | 内部 ID 与 PI Provider ID 分离                         | 等价                     |
| MCP `isError`                 | 现有受控 executor 映射失败                                   | 保留 `isError` 并生成 failed call                      | 等价                     |
| progress / parallel           | 已有生命周期与并行测试                                       | PI event + NDJSON progress；并行完成顺序测试通过       | 等价                     |
| cancel                        | Abort 后等待工具审计终态                                     | abort → `tool.cancel` → 等待 `tool.result`             | 等价                     |
| content / reasoning           | Provider delta 投影                                          | 只投影 PI 明确返回的 text/thinking delta               | 等价，不保存隐藏思维链   |
| Context Bundle                | 已持久化与审计                                               | run.started 记录 bundle ID/hash，完整 request 传入     | 等价                     |
| usage / finish reason         | 已聚合                                                       | PI assistant messages 聚合 usage/stopReason            | 等价                     |
| structured output             | 本地 validator + repair                                      | 本地 descriptor registry 验证；未复刻 repair           | PI 有缺口                |
| authorization steering        | 生产支持授权等待与回复                                       | 本原型只开放免授权的 trusted + readOnly MCP            | PI 有缺口                |
| Provider / credential / proxy | OpenAI、Anthropic、DeepSeek、Qwen 与 Tauri HTTP 代理已有证据 | 只运行 PI 官方 faux provider；没有真实密钥或代理 smoke | PI 证据不足              |
| 累计预算                      | Phase 1 仅输出与模型轮次硬限制                               | 映射 max output/model turns；并行上限仅支持 1 或并行   | 均不得宣称累计成本硬限制 |

定向自动化覆盖串联工具、并行工具、MCP 业务错误、progress、独立 ID、Patch 转换、reasoning/content、usage、finish reason、structured descriptor、duplicate run、取消唯一终态和 NDJSON 取消等待。Rust 定向测试覆盖 Worker 异常退出时只把仍在 `pending/running` 的对应 Run 标记为 `interrupted`，同时由现有 trigger 将治理 `task_run` 投影为 failed；已完成 Run 不受影响。

## 决策理由

1. PI 的事件和工具模型适合 Node Worker，原型没有发现架构性阻断。
2. `pi-agent-core` 本身依赖 `pi-ai`。即使注入自定义 `streamFn` 复用现有模型层，选项 2 也不会消除 `pi-ai` 的传递依赖，收益小于额外适配成本。
3. 选项 3 可以减少未来 Provider 胶水，但真实 Provider、兼容 endpoint、Tauri 代理、凭据解析、structured repair 和授权恢复尚未完成同等验收。
4. Phase 3 的核心风险是进程所有权、监督、RPC、打包和重启恢复。先保留 AI SDK，可让该阶段只改变运行位置，不同时改变模型循环语义。

## 后续约束

- Phase 3 Worker 先承载 AI SDK Adapter；不得把 PI prototype 直接路由到生产模式。
- PI package 不进入 Tauri bundle，不要求最终用户安装 Node；自包含 Worker 打包由 Phase 3 验收。
- 若未来重新开启 PI 切换，必须补齐真实 Provider/Tauri proxy smoke、授权等待、structured-output repair、数值并行上限和安装升级测试，再重新做显式决策。
- Rust Core、Domain Tool、MCP、Skill、审批、Patch 和 SQLite 所有权不因本决策变化。
