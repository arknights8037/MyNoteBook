# P1 Knowledge、Work、Verifier 与 View

P1 在 P0 的可信 Document Core 和 Context Bundle 上增加结构化控制层，同时保持 Tiptap JSON 为唯一正文事实源。Migration 为 `0010_add_p1_knowledge_work_views.sql`。

## 边界与流程

1. Knowledge Object 将 Rule、Decision、Evidence、ChangeSet 的语义锚定到 document/block/revision；不复制或直接编辑正文。
2. TaskDefinition 描述可复用任务，TaskRun 保存一次冻结执行。Automation 与 Agent 历史表通过映射和兼容 trigger 继续工作。
3. Artifact 与 Evidence 由 TaskRun 产出。Result Verifier 根据验收规则、来源有效性和审批要求形成不可变结论，并在同一 Rust transaction 中推进 TaskRun 或提出 ChangeSet。
4. ChangeSet 经 Approval 后仍须走既有 Patch/Diff/Document Core 原子写入，不提供旁路。
5. Query/Projection View 手工读取 Document FTS 或明确的 Document/Knowledge ID，生成不可变 snapshot 和 dependency 集。来源改变后当前 snapshot 标记 stale。

## 状态与不变量

TaskRun 状态超集为 `queued`、`running`、`waiting_input`、`waiting_approval`、`blocked`、`completed`、`failed`、`cancelled`、`timed_out`、`stale`；服务层显式校验迁移，repository 不允许任意覆盖。

- Verifier 不修改正式知识或正文。
- View 不作为事实源；刷新不覆盖历史 snapshot/dependency。
- `current_snapshot_id` 是 stale 判定的唯一当前依赖集合。
- `readonly` View 不产生写入；`propose_changeset` 只生成待审批提案。
- 旧 Automation/Agent ID 和记录保留，避免破坏已有运行历史与 UI。

## 当前非目标

Generated View、自动刷新、用户覆盖合并、外部 Agent 委派、MCP Server、Domain Event/Outbox 和 Provider Capability Matrix 属于 P2。
