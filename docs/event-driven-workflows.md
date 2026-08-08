# 事件驱动 Workflow 与 Action Gateway

> 状态（更新于 2026-08-09）：P5 的统一 Work Item/Workflow、可恢复等待和 Rust Action Gateway 已进入主干。P6 已把 Durable Timer、Outbox、correlation Event 匹配、已满足等待续接、Automation/Signal/A2A ingress 与执行调度、Action lease 恢复扫描、钉钉 Connector 和 Worker Supervisor 迁入 Headless Core。当前没有启用邮件发送、IM 回复或发布等真实外部动作处理器；这是阶段范围约束，不由占位 handler 替代。

## 1. 所有权与事实源

Rust Core 是 Workflow、等待条件、外部动作审批、lease、fencing 和终态的唯一所有者。Vue 只提交人工请求或展示只读投影；sidecar 只执行一次有界 Agent Run，不能修改 Workflow 或外部动作状态。

```text
Domain Event
  -> 去重与来源分类
  -> workflow_work_items
  -> workflow_instances
  -> workflow_run_attempts（每次续接使用新的 run_id）
  -> Agent Run / Deterministic Action
```

`workflow_work_items` 保存来源事件、`manual/timer/rss/related_update` 分类、correlation、causation 和去重键。`workflow_instances` 保存 `READY/RUNNING/WAITING_*/RETRY_SCHEDULED` 与终态；`workflow_run_attempts` 保证一个结束的 Run 不会被原地唤醒。

## 2. 已接通来源

- 人工：手动自动化和首页“处理相关更新”进入统一 Work Item/Workflow。
- Timer：计划自动化由 Rust 调度；通用 `WAITING_TIMER` 使用 Durable Timer，触发事件与等待满足在同一事务提交，Workflow 随后回到 `READY`。
- RSS：RSS 自动化在同步、canonical 去重和冻结增量输入后创建 `rss` Work Item，再决定并启动只读 Agent。
- 相关更新：`workspace.signals.refreshed` 继续驱动信号 Agent，并复用统一 Workflow 身份。

同一来源事件或自动化运行重复消费只返回已有 Work Item/Workflow。失败重试先结束旧 attempt，再以新的 `run_id` 启动；迟到旧 Run 不能结算当前 attempt。

## 3. 等待与续接

统一等待状态为 `WAITING_EVENT`、`WAITING_TIMER`、`WAITING_HUMAN`、`WAITING_APPROVAL` 和 `RETRY_SCHEDULED`。`SuspendRequestV1` 只描述等待种类、去重键、payload 和可选 `dueAt`；Rust 会结束当前 Run 并持久化等待条件。

- Event 等待只接受同一 correlation 下、等待创建后的目标事件；满足后保存完整 v1 事件 envelope 作为 resume payload。
- Timer 继续使用绝对 UTC、lease、退避和 Dead Letter；触发后原子满足等待并把 Workflow 推进到 `READY`。
- Human/Approval 的决定与 resume payload 持久化，不依赖窗口或 Worker 生命周期。
- 续接必须调用 `start_run` 创建新的 `run_id` 和 attempt number；Runtime v1 仍不提供 `resumeRun`。

## 4. Action Gateway

所有未来真实外部副作用必须先写入 `external_action_requests`，并经过以下状态机：

```text
pending_approval -> approved -> executing -> completed
                 -> rejected
                              -> approved（有界重试）
                              -> failed / dead_lettered
```

- `idempotency_key` 在动作级唯一；相同键携带不同目标或输入会被拒绝。
- 审批决定写入 `external_action_approvals` 并满足对应 `WAITING_APPROVAL`。
- 只有 approved 动作可领取；每次领取递增 fencing token，并保存 attempt、lease owner 与 lease expiry。
- 结算必须同时匹配 action、lease owner 和 fencing token；旧 worker 的迟到结果被忽略。
- 审批、请求事件、完成事件和 Outbox 都由 Rust 在事务边界内写入；过期执行 lease 在启动恢复时重排，耗尽后进入 Dead Letter。

当前没有注册真实外部动作 dispatcher，也没有开放 WebView mutation command。后续增加邮件、IM、发布或外部日历处理器时，只能实现 Rust 内部 allowlist handler，并复用上述状态机。

## 5. 权限与失败恢复

- RSS、邮件、IM 和网页内容始终视为不可信输入，不能改变工具清单或审批语义。
- 本地待办/日历仍是 signal intent 的专用幂等本地动作，不冒充外部动作。
- 知识正文修改继续走 `mutationApproval` 和 Rust canonical transaction。
- 外部动作继续走 `externalActionApproval`、Action Gateway 和 Outbox；没有审批不能领取。
- 显式退出整个 Tauri 进程后，Headless Core 仍会处理 Timer、等待续接、Automation/Signal 持久化入队和 Action lease 恢复；具体 Workflow/Automation/Signal Run、A2A、Connector 与 Worker 执行调度仍会停止，并在 Desktop 重启后领取持久化队列继续处理。
