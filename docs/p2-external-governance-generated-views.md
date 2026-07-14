# P2 External Delegation、Governance 与 Generated View

## Generated View

Generated View 只能手动刷新。每次生成都冻结 Document/Knowledge dependency revision、source snapshot hash、Provider、model、Skill 版本、时间和 correlation/causation ID。

当 `manual_override=1` 时，新结果保存为 `preview` 且 `protected_by_override=1`，不会修改 `current_snapshot_id`、override 内容或 stale 状态。用户可选择 readonly、生成 ChangeSet，或明确分叉为不再跟随来源的普通文档。

## External Delegation

Delegation 将一个 TaskRun、可选 Context Bundle、外部 actor、有效期和 operation allowlist 绑定到随机 capability token。token 明文只在创建时显示，数据库仅保存 hash。

外部提交支持 Artifact、Evidence、Result 和 ChangeSet。Result 只把 TaskRun 置为等待 verifier 的 `blocked`；ChangeSet 只进入 `proposed`。任何路径都不能直接更新 documents。

CLI Adapter 使用 v1 JSON envelope。独立 `mynotebook-mcp` stdio Server 以 query-only SQLite 连接暴露：

- `mynotebook://knowledge/rules`
- `mynotebook://knowledge/decisions`
- `mynotebook://tasks/open`
- `mynotebook://context/{bundleId}`

启动示例：`mynotebook-mcp --database-url "sqlite://.../editor.db?mode=ro"`。

Server 同时提供带 `readOnlyHint` 的 `search_knowledge` 工具，用于搜索文档的规范纯文本投影；连接仍处于 SQLite query-only 模式。

## Event 与 Outbox

验证、审批、View refresh/override、Delegation 创建和外部提交均在业务 transaction 内同时写 Domain Event 与 Outbox。Outbox worker 使用短 lease；崩溃后消息可以重新领取，重复消费方应使用 event ID 幂等。

## Provider Capability

Capability Matrix 是请求与 UI 的共同决策点。未知 OpenAI-compatible endpoint 使用保守能力，默认不声明 tool choice、reasoning 或 structured output 支持。运行 provenance 分别保存 requested、actual 和 ignored 参数。
