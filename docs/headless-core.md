# Headless Core 进程与本地协议

本文记录 Phase 6 的最终实现事实和协议安全边界。独立 Core 控制进程已承接 Desktop 发现协议、WebView 数据库 prepare/query/mutation catalog、Durable Timer、带订阅确认的 Outbox publisher、Workflow Event/等待续接、Automation/Signal/A2A ingress 与执行调度、Action 过期 lease 恢复、钉钉 Stream Connector，以及 Agent Worker Supervisor。Desktop 后台运行面板通过受控命令和带序号事件投影订阅脱敏状态，不接触 endpoint 凭证；退出 Desktop 不会终止上述 Runtime。

## 当前进程拓扑

```text
MyNoteBook Desktop (Tauri/WebView)
  -> 发现或拉起同版本 my-notebook --mynotebook-headless-core
  -> 读取用户配置目录中的 endpoint-v1.json
  -> Bearer credential + protocol handshake
  -> 127.0.0.1 随机端口上的 Headless Core 控制面

Agent Runtime Worker
  <- 由 Headless Core Rust Supervisor 通过 NDJSON stdio 管理
```

Headless Core 使用与 Desktop 相同的可执行文件，通过专用进程参数进入无 Tauri、无 WebView 的 Tokio/Axum 入口。Desktop 只负责发现或拉起 Core，不保留会在 drop 时终止 Core 的 child handle；关闭窗口或退出 Desktop 不会主动发送 Core shutdown。

## Endpoint 与身份

Core 只绑定 `127.0.0.1:0`，启动后在应用用户配置目录的 `headless-core/endpoint-v1.json` 原子发布：

- 随机端口；
- CSPRNG 生成的 256-bit 实例凭证；
- 凭证指纹形成的 instance ID；
- PID、启动时间、应用版本；
- 协议 major/minor。

所有 HTTP 路由都要求 Bearer credential。Desktop 暴露给 WebView 的状态快照不包含地址或凭证。Unix endpoint 文件使用 `0600`；Windows 依赖应用用户配置目录的用户 ACL，发布安装前还需要完成安装器账户隔离验收。

实例 lock 只用于协调并发启动，不被当作存活事实。发现端会使用 endpoint credential 执行真实健康检查；失效 endpoint/lock 可被新实例回收。

## 协议 v1

当前控制面提供：

| 路由                                | 用途                                                              |
| ----------------------------------- | ----------------------------------------------------------------- |
| `GET /v1/health`                    | 校验实例身份、PID、角色和协议版本                                 |
| `POST /v1/handshake`                | 校验 major，协商双方支持的 minor                                  |
| `POST /v1/shutdown`                 | 受凭证保护的显式维护关闭；Desktop 退出不调用                      |
| `POST /v1/database/prepare`         | 创建或升级数据库，并启动该目录的 Core 后台运行时                  |
| `POST /v1/database/query`           | 执行 WebView catalog 的只读查询                                   |
| `POST /v1/database/mutation`        | 执行封闭 mutation catalog                                         |
| `POST /v1/database/close-read-pool` | 关闭指定目录的 Core 只读池                                        |
| `POST /v1/database/close-pool`      | 停止匹配的 Core 后台运行时并关闭指定目录的 Core 读写池            |
| `POST /v1/timer/snapshot`           | 返回 Core 持有的 Timer 健康与积压快照                             |
| `POST /v1/workflow/snapshot`        | 返回 Workflow/Automation/Signal/Action scanner 健康与累计处理快照 |
| `POST /v1/outbox/snapshot`          | 返回 Outbox publisher 的脱敏健康、发布累计与积压快照              |
| `POST /v1/connectors/snapshot`      | 返回 Connector 运行状态、活动数量与脱敏消息累计                   |
| `POST /v1/connectors/reconcile`     | 按数据库启用状态在 Core 内停止并恢复 Connector                    |
| `POST /v1/scheduler/snapshot`       | 返回 A2A/Automation/Signal 调度健康与聚合队列投影                  |
| `POST /v1/scheduler/reconcile`      | 确认指定数据目录的 Core 后台执行调度正在运行                       |
| `POST /v1/worker/projection`        | 按序号读取 Worker 快照与脱敏事件，支持 Desktop 重连补投影          |
| `POST /v1/worker/start`             | 在 Core 内启动或确认 Worker Supervisor                             |
| `POST /v1/worker/run`               | 向 Core Worker 提交已组装 Run 请求                                 |
| `POST /v1/worker/orchestration`     | 在 Core 内组装 MCP 工具后提交编排请求                              |
| `POST /v1/worker/cancel`            | 取消活动 Run                                                       |
| `POST /v1/worker/steer`             | 向活动 Run 提交 steer 输入                                         |
| `POST /v1/worker/shutdown`          | 显式停止 Worker；不停止 Headless Core                              |
| `POST /v1/worker/terminal`          | 读取 Core 持久化前的待确认终态缓冲                                 |
| `POST /v1/worker/terminal/acknowledge` | 确认 Desktop 已消费终态缓冲                                     |
| `POST /v1/runtime/quiesce`          | 中止并等待全部 Core 后台任务，用于数据目录迁移                    |
| `POST /v1/runtime/resume`           | 在迁移成功的目标目录或失败回滚的原目录恢复原有 Core 后台任务      |

major 不一致必须拒绝连接；Core minor 低于 Desktop 所需 minor 时同样拒绝，较旧 Desktop 可连接较新 Core。Desktop 发现不兼容实例后使用旧 endpoint 的受权 shutdown 完成替换，不能让缺少新路由的旧 Core 继续服务。endpoint 中的实例身份必须与在线响应一致，不能只信任 PID 或磁盘文件。

## 所有权边界

Phase 6 已按以下顺序完成所有权迁移，迁移期间没有同时运行两个领取同一事实的 scanner：

1. 数据库路径解析、migration 和 WebView mutation/query catalog 进入 Core RPC；WebView 不拥有 SQL capability。
2. Durable Timer、Outbox、Workflow、Automation、Signal、A2A、Action lease recovery 和 Connector watcher 进入 Core。
3. 将 Agent Worker Supervisor 移入 Core；Desktop 仅订阅脱敏事件并提交交互命令。（已迁移）
4. 数据目录迁移使用 Core 级 quiesce/resume，并在恢复失败时回滚已启动的 Runtime；Desktop 同步关闭自身交互 read/write pool 后再移动目录。
5. Desktop/Core/Worker 的身份、版本不兼容、旧 endpoint、Worker 崩溃、活动 Run orphan recovery 和并发写入均有自动化契约；安装器签名和真实发布升级继续属于并行发布质量轨道。

SQLite 的“唯一写入者”指 Rust 信任边界和领域事实单一所有者，不表示只有一个 OS 进程能打开文件。Core 独占所有后台 scanner、lease、Connector 和 Run 事务；Desktop Rust command 保留显式用户交互事务。SQLite WAL/busy timeout 负责物理写入串行化，revision、幂等键、lease owner 与 fencing token 负责语义冲突；任何 WebView、Worker 或 Connector SDK 都不能直接持有 SQLite handle。

## 验收边界

- 单元测试覆盖随机身份、参数解析、凭证不进入 UI snapshot，以及 Core Timer 的停止边界。
- Core loopback 集成测试会准备真实数据库、插入到期 Timer，并验证 Core 独立触发 Domain Event/Outbox；同一测试还会建立 correlation Event 等待，验证 Core 将 Workflow 续接为 `READY`，并覆盖统一后台任务 quiesce/resume。
- Core ingress 测试验证 Automation 到期任务和 Signal Domain Event 只入队一次，同时回收过期 Action lease；测试不启动 Desktop、Tauri 或 Agent Worker。
- Core loopback 集成测试验证 Outbox 只有在 Core 订阅者接收后才确认发布，并覆盖 publisher 的暂停与恢复。
- Core loopback 集成测试覆盖 A2A/Automation/Signal 调度器投影、暂停与恢复，并并发提交两个 catalog mutation 验证写入协调。
- 无 Tauri Worker 测试使用可控假 Worker，验证 Core 能监督心跳、投影 Run 事件，并在 Worker 崩溃后进入有界重启周期；Core loopback 测试同时覆盖 Worker quiesce/resume 边界。
- 进程测试使用真实无 Tauri binary，验证 endpoint 发布、未授权拒绝、协议协商、受权 shutdown 和 endpoint 清理。
- 不开放非 loopback 地址，不加入生产 CSP，不允许 WebView 读取 endpoint 文件或直接连接 Core。
