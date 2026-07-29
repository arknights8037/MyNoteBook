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

## 未来执行与等待边界（尚未实现）

Rust Core 将拥有调度指针、lease、heartbeat、retry、dead letter 和 durable timer，并通过 Runtime Port 提交、取消和订阅有界 Agent Run。Node Worker 不读取自动化表或 SQLite，只处理 Rust 通过 RPC 提供的 Run 请求与领域工具。

Agent Run 不跨长时间等待占用 Worker：当流程等待外部事件、定时器、用户输入、审批或重试窗口时，当前 Run 结束；Workflow 持久化等待条件。条件满足后，由 Rust 以新的 `run_id` 启动后续 Run，并用 `workflow_id` 与 `causation_id` 关联前后执行。`resumeRun` 只有在未来具备 durable checkpoint 后才可能引入，Runtime v1 不承诺该能力。

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
