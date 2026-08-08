# Headless Core 进程与本地协议

本文记录 Phase 6 的当前实现事实、协议安全边界和后续迁移顺序。Phase 6 尚未完成；当前已落地独立 Core 控制进程、Desktop 发现协议，以及 WebView 数据库 prepare/query/mutation catalog，Workflow、Connector、Action 和其他 Rust 数据库所有权仍在后续迁移中。

## 当前进程拓扑

```text
MyNoteBook Desktop (Tauri/WebView)
  -> 发现或拉起同版本 my-notebook --mynotebook-headless-core
  -> 读取用户配置目录中的 endpoint-v1.json
  -> Bearer credential + protocol handshake
  -> 127.0.0.1 随机端口上的 Headless Core 控制面

Agent Runtime Worker
  <- 当前仍由 Desktop Rust Supervisor 通过 NDJSON stdio 管理
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

| 路由                 | 用途                                          |
| -------------------- | --------------------------------------------- |
| `GET /v1/health`     | 校验实例身份、PID、角色和协议版本             |
| `POST /v1/handshake` | 校验 major，协商双方支持的 minor              |
| `POST /v1/shutdown`  | 受凭证保护的显式维护关闭；Desktop 退出不调用  |

major 不一致必须拒绝连接；Core minor 低于 Desktop 所需 minor 时同样拒绝，较旧 Desktop 可连接较新 Core。Desktop 发现不兼容实例后使用旧 endpoint 的受权 shutdown 完成替换，不能让缺少新路由的旧 Core 继续服务。endpoint 中的实例身份必须与在线响应一致，不能只信任 PID 或磁盘文件。

## 所有权迁移顺序

当前控制面不等于 Phase 6 完成。后续必须按以下顺序迁移，期间不得同时宣称两个进程拥有同一事实：

1. 将数据库路径解析、migration、读写 pool 和 mutation/query catalog 移入 Core RPC。（已迁移 WebView catalog；其他 Rust 领域模块仍待迁移）
2. 将 Durable Timer、Outbox、Workflow、Automation、Signal 和 Connector watcher 移入 Core。
3. 将 Agent Worker Supervisor 移入 Core；Desktop 仅订阅脱敏事件并提交交互命令。
4. 为数据目录迁移建立 Core 级 quiesce/commit/rollback，Desktop 不再直接关闭 pool。
5. 完成 Desktop/Core/Worker 各自崩溃、重启、版本不兼容、旧 endpoint、活动 Run 和安装升级验收。

在第 1–4 步完成前，SQLite 尚未达到进程级唯一所有权：WebView catalog 已由 Headless Core 执行，但现有 Desktop Rust 领域模块仍会打开数据库。文档和实现都不得把这段迁移期描述成 Core 已完全接管。

## 验收边界

- 单元测试覆盖随机身份、参数解析和凭证不进入 UI snapshot。
- 进程测试使用真实无 Tauri binary，验证 endpoint 发布、未授权拒绝、协议协商、受权 shutdown 和 endpoint 清理。
- 不开放非 loopback 地址，不加入生产 CSP，不允许 WebView 读取 endpoint 文件或直接连接 Core。
