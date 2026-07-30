# 自动化任务与审计

> 状态（更新于 2026-07-30）：自动化定义、手动触发、间隔/每日调度和 Rust 后台 Agent 执行已经接通。首个信息来源为 RSS；IM 收纳、外部委派和真实外部动作仍不在本轮范围。

## 1. 当前执行链路

```text
automation_tasks
  -> 手动“立即运行”或 Rust 检查 next_run_at
  -> automation_runs(status = queued)
  -> Rust 原子领取 + lease + attempt
  -> 冻结文档/RSS 输入
  -> Rust Supervisor -> AI SDK sidecar（只读 Agent）
  -> completed / retry scheduled / failed / waiting_approval
  -> task_runs 与审计投影
```

WebView 只创建定义、请求手动运行和展示投影，不领取队列、不启动模型、不结算终态。Rust watcher 与 A2A 共用已经配置且不含密钥的后台 Runtime Profile，但自动化使用独立的 `automation_runs` lease、`run_id`、Agent Task 绑定、重试和 Dead Letter 字段。

## 2. 调度与恢复

- 手动触发和计划触发进入同一运行队列；每个自动化最多有一个 queued/running 运行。
- 间隔与每日任务的 `next_run_at` 是持久调度指针。应用休眠或窗口隐藏后，Rust 会在恢复时补领到期任务。
- 运行最多尝试三次；可重试失败使用有界指数退避，耗尽或非重试错误进入可诊断失败终态。
- 每次尝试使用新的 Agent `run_id`；旧 Run 的迟到终态不能覆盖当前尝试。
- 应用重启时，仍由 Supervisor 持有的 Run 保留；失去所有者的运行被回收并重排或进入 Dead Letter。

## 3. RSS 自动化

任务可选择“RSS 新增内容”作为输入。每次运行前，Rust 会：

1. 同步所有已启用 RSS 源，复用现有 URL/重定向/私网阻断和正文提取安全边界；
2. 按 `(source_id, remote_id)` 去重并更新本地 canonical RSS 收件箱；
3. 计划运行只冻结上次成功游标之后的 pending 条目，手动运行冻结最近 pending 条目；
4. 把最多 40 条标准化内容作为不可信数据交给只读 Agent；
5. 成功后推进自动化来源游标，并把热点摘要保存在 `automation_runs.output_json`。

RSS 正文中的角色设定、链接要求或操作指令不能改变系统指令或工具权限。

## 4. 权限边界

当前自动化使用 `plan` 意图，只开放只读与诊断工具，不允许文档 Patch、资源草稿或外部动作。这样可以无人值守地生成摘要、发现和建议，而不会产生缺少审阅入口的后台修改。

需要正式修改时，后续 Workflow 必须进入独立 `mutationApproval`；邮件发送、IM 回复和发布必须经过 `externalActionApproval`、Action Gateway 和 Outbox。

## 5. 当前未完成

- IM/邮件信号自动收纳和任务候选；
- 自动化触发外部委派；
- 邮件发送、IM 回复、发布等真实外部副作用；
- 通用事件 Trigger 编辑器和完整 SuspendRequest/等待条件编排；
- 显式退出 Tauri 进程后的系统服务运行。
