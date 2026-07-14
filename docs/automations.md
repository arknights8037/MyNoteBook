# 自动化任务与审计

## 当前边界

自动化模块提供本地任务定义、调度指针、运行队列和状态生命周期。当前版本不在后台主动唤醒模型；桌面调度器或其他执行器可以通过 `AutomationService` 领取到期任务并推进运行状态。

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

“自动化任务”页面支持创建定义、绑定当前页面、手动/间隔/每日触发、启停、手动入队和查看最近运行。

“审计记录”页面统一展示：

- Agent 任务
- Agent 工具调用
- Patch 确认事件
- 自动化运行

审计详情按需展开。页面当前查询最近 300 条记录；跨时间范围分页、导出和清理策略留待后续。
