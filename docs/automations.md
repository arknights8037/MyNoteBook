# 自动化任务与审计

## 当前边界

自动化模块提供本地任务定义、调度指针、运行队列和状态生命周期。当前版本没有后台调度 Worker，也不会主动唤醒模型；现有 UI 只能创建定义、计算到期状态和手动入队。目标执行边界是 Rust 调度、lease 与恢复扫描通过统一 Runtime Port 启动 Agent Run；AI SDK 或未来 PI 只能作为该 Port 后的可替换 adapter，不能建立并行的第二套生产循环。

```text
automation_tasks
  -> listDueTasks(now)
  -> enqueueTask(task, "schedule")
  -> automation_runs(status = queued)
  -> startRun(runId)
  -> completeRun(runId, output) / failRun(runId, error)
```

## 一致性

运行入队由单条 SQLite `INSERT` 完成。`automation_runs_after_insert` trigger 在同一事务中更新任务的 `last_run_at` 和 `next_run_at`。部分唯一索引限制每个自动化最多存在一条 `queued` 或 `running` 记录，避免调度器并发轮询时重复入队。

运行的 `input_json` 保存入队时冻结的指令和文档 ID。删除自动化定义时，历史运行通过 `ON DELETE SET NULL` 保留，执行器仍可依据冻结输入处理已入队任务。

## 页面

“自动化任务”页面支持创建定义、绑定当前页面、手动/间隔/每日触发、启停、手动入队和查看最近运行。没有执行器时，手动或计划入队只会生成 `queued` 记录，页面会提示等待执行器，不应把它描述成后台任务已经运行。

当前实现分布在 `src/models/automation`、`src/services/automation`、`src/repositories/automation`、`src/infrastructure/database/automation` 和自动化页面组件；migration `0008` 拥有表、触发器与唯一索引。

## 执行与等待边界

Rust Core 已拥有通用 Durable Timer/等待条件、lease、retry、Dead Letter 和 Outbox 原子触发；Node Worker 不读取自动化表或 SQLite，只处理 Rust 通过 RPC 提供的 Run 请求与领域工具。当前自动化模块仍未把 `automation_tasks` 调度指针接到该 timer primitive，也没有后台模型执行器，因此页面中的计划任务仍只入队。把自动化与 RSS 事件接入可恢复 Workflow 属于 Phase 5。

Agent Run 不应跨长时间等待占用 Worker：目标语义是当前 Run 结束，由 Workflow 持久化外部事件、定时器、用户输入、审批或重试条件。migration `0039` 当前只负责持久化条件，并在 Timer 到期时原子写入 Domain Event/Outbox；消费该事件、创建新的 `run_id` 并用 `workflow_id` / `causation_id` 关联后续执行仍属于 Phase 5。`resumeRun` 只有在未来具备 durable checkpoint 后才可能引入，Runtime v1 不承诺该能力。

详细阶段、契约和退出条件见 [后续开发路线图](roadmap.md)。

“活动与审计”页面统一展示：

- Agent 任务
- Agent 工具调用
- Patch 确认事件
- 自动化运行
- 统一 TaskRun
- Knowledge Object 与 Result Verification
- ChangeSet、Approval 与 View 刷新
- Delegation、Domain Event 与 Outbox

审计详情按需展开。页面当前查询最近 300 条记录；跨时间范围分页、导出和清理策略留待后续。
