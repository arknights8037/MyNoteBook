# 数据库持久化与运维

## 唯一 Schema 所有者

SQLite schema 只由 `src-tauri/migrations/` 中的 SQLx 迁移管理。应用启动时 Rust 端按版本执行迁移，并把 checksum 写入 `_sqlx_migrations`。

截至 2026-07-30，当前迁移链为 `0001`–`0041`。最新迁移已包含 Runtime Port 身份/审批契约、后台 Agent Runtime Profile、A2A 请求 lease/retry/Dead Letter、Durable Timer/统一等待条件，以及 Event Envelope v1、有界 Outbox Dead Letter 字段和 processing lease 索引恢复。

前端不再执行 `CREATE TABLE`、`ALTER TABLE` 或补列逻辑。这样避免了两个运行时同时管理 schema，防止“每次打开都提示迁移”或已应用迁移 checksum 不匹配。

所有 `src-tauri/migrations/*.sql` 通过 `.gitattributes` 固定为 LF。已发布 migration 必须保持字节不可变；后续结构调整只能新增 migration。架构测试固定 migration `0029` 的 SHA-384，避免 Windows CRLF 检出改变 SQLx checksum。2026-07-30 已用实际版本 35 用户库验证升级到 41，数据库完整性与外键检查通过。

Rust 是 SQLite 唯一连接所有者与唯一写入者。WebView repository 写操作只提交封闭的 mutation ID 和标量参数，由 `database_mutations.rs` 选择固定 SQL；不能提交任意写语句。参数化读取由 `database_queries.rs` 在独立只读 SQLx pool 中执行并序列化结果，只接受单条 `SELECT/WITH`，同时启用 `read_only` 与 `query_only`；主窗口没有 SQL capability，项目也不再依赖 `plugin-sql`。

**规则：已发布迁移不可修改、不可删除、不可重排。** Schema 变更必须新建下一个编号迁移。例如 `0006_add_x.sql`。历史迁移是已有用户数据的版本链，不是运行时兼容代码。

## 当前持久化内容

| 域               | 表/文件                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档与层级       | `documents`；只读块投影 `blocks`                                                                                                                                             |
| 标签             | `tags`、`document_tags`                                                                                                                                                      |
| 附件元数据       | `assets`；二进制文件位于数据库同级 `assets/`                                                                                                                                 |
| 本地集成文件     | `skills/`、`mcp-servers.json`、`mcp-server-exposure.json`；与数据库使用同一个可迁移数据目录                                                                                  |
| 全文检索         | FTS5 `document_search` 与同步触发器                                                                                                                                          |
| Agent 任务与审计 | `agent_*` 表保存 task、tool call、Patch、confirmation、transaction 和 request；`agent_workspace_state` 保存版本化项目/任务消息快照                                           |
| 消息连接器       | `im_connectors` 保存非敏感连接配置和运行状态；`im_conversations`、`im_messages` 保存标准化钉钉会话与消息；Client Secret 不进入 SQLite                                        |
| 独立信息首页     | `information_home` 保存单例模块布局与自动摘要设置；`information_home_summaries` 保存只读 Agent 摘要历史，不属于 `workspace_views`                                            |
| Agent 通信与路由 | `agent_requests` 保存 mode、result、revision、decision、project/branch routing、run/session binding、lease、attempt/retry 和 Dead Letter；`agent_branches` 保存 A2A 分支目录 |
| 自动化与运行队列 | `automation_tasks`、`automation_runs`                                                                                                                                        |
| 上下文追溯       | `context_bundles`；Agent ExecutionPolicy、Provider 参数、Skill 版本与关联 ID                                                                                                 |
| 结构化知识       | `knowledge_objects`、`knowledge_object_relations`                                                                                                                            |
| 认知会话与验证   | `cognitive_sessions`、`knowledge_object_sources`、`knowledge_validations`                                                                                                    |
| Mind Map         | `mind_maps`、`mind_map_revisions`；版本化 canonical JSON 与树形位置                                                                                                          |
| 结构化工作区     | `workspace_views`、`workspace_view_revisions`；Slidev/UML/Table payload、树形位置与 `pinned_at`                                                                              |
| 统一 Work        | `task_definitions`、`task_runs`；兼容既有 Automation/Agent 表                                                                                                                |
| 交付与治理       | `work_artifacts`、`work_evidence`、`result_verifications`、`change_sets`、`approvals`；验证结果可保存 Confirmation Envelope 与 hash                                          |
| 可重建 View      | `view_definitions`、`view_snapshots`、`view_dependencies`                                                                                                                    |
| 外部委派         | `delegations`、`external_submissions`、`idempotency_records`                                                                                                                 |
| 事件投递         | `domain_events`、`outbox_messages`                                                                                                                                           |
| Workflow 等待    | `workflow_wait_conditions`、`workflow_timers` 保存 timer/event/human/approval 条件、lease、重试与 Dead Letter                                                                |
| API Key          | AES-256-GCM 密文文件；随机数据密钥由系统凭据库保护，不进入 SQLite 或 localStorage                                                                                            |

API Key 首次使用时从系统凭据库取得数据密钥并完成一次 AES-GCM 解密，随后缓存在应用进程内存中。Agent 请求不会重复执行 KDF、系统凭据读取或 AES 解密。写入时使用新的随机 nonce，GCM 认证标签同时校验密文完整性。

文档以 `content_json`、`plain_text`、`revision` 保存。`revision` 是写入与 Agent 撤销的乐观并发保护；任何保存都会递增 revision。

从 migration `0009` 起，普通创建、保存和元数据更新统一调用 Rust `document_core::persist_document`。Rust 校验 Tiptap `doc`、顶层稳定 block ID 和重复 ID，并从 `content_json` 确定性生成 `plain_text`；调用方提交的纯文本不再作为写入事实。文档、标签与块投影在同一 SQLx transaction 中提交。

`blocks` 保存顶层块的稳定 ID、类型、顺序、块 JSON、纯文本和所属文档 revision。它是 `content_json` 的只读规范化投影，不是第二写入入口。Migration `0013` 移除了旧的 SQLite JSON trigger；普通保存、Agent 写入、撤销和投影修复统一复用 Rust projector，并在同一事务中写入，避免 SQL/Rust 两套文本语义和重复重建。永久删除依靠外键级联清理。业务代码通过 `DocumentRepository.listBlocks` 读取，不直接修改该表。

`document_core::rebuild_document_projections` 可按单文档或全库检查并修复 `plain_text`、`blocks` 和 FTS5 漂移，不改变正文 JSON 或 revision。无法解析或缺少稳定 block ID 的旧文档会进入结果的 `errors`，不会被静默覆盖。

## P1 Knowledge、Work 与 View

Migration `0010` 增加统一读取/写入模型，但不替换旧表。`automation_tasks` 映射为 `task_definitions`，`automation_runs` 与 `agent_tasks` 映射为 `task_runs`；Agent Patch set/transaction 映射为 `change_sets`。兼容 trigger 同步必要状态，新功能应优先通过 P1 repository 和 Rust 原子 command 写入。

Migration `0014` 扩展 `knowledge_objects` 的候选类型、正文、结构化数据和认知 provenance，并增加 `rejected` 状态、多来源与 Knowledge Validation。旧对象保持原 ID、版本、关系、Task source、View dependency 和单来源锚点；旧锚点会无损映射为 `knowledge_object_sources`。`cognitive_sessions` 独立保存 active/waiting_user/completed/cancelled 状态与乐观版本，不把认知状态只放在聊天或 Prompt 中。

`work_artifacts` 是运行交付物，`work_evidence` 保存可验证来源和验证状态，`result_verifications` 保存不可变的 verifier 结论。Verifier 可更新 `task_runs` 或提出 `change_sets`，不能绕过既有 Document Core/Patch 事务直接改正文。

每次 View 手工刷新新增一条 `view_snapshots` 及其 `view_dependencies`，并由 `view_definitions.current_snapshot_id` 指向当前版本。历史依赖永久保留；文档 revision 或 Knowledge Object 版本变化时，trigger 只根据当前快照依赖标记 stale。View 是可重建投影，不是第二事实来源。

这里的 Generated View 与工作区里的 `workspace_views` 不是同一概念。前者是可重建查询投影；后者保存用户直接编辑的 Slidev、UML 或 Table canonical payload，并通过独立 revision 表记录历史。`mind_maps` 同样是直接编辑的版本化工作区资产，不应写入 `view_snapshots`。

## 近期工作区与 Agent 通信迁移

- `0020`–`0023` 增加 Mind Map、结构化工作区视图、各自 revision history 和树形父级/排序位置。
- `0024` 为 `agent_requests` 增加认知请求模式。
- `0025` 为 `result_verifications` 增加版本化 Confirmation Envelope JSON 与 hash。
- `0026` 只为 `workspace_views` 增加 `pinned_at`；Mind Map 当前没有置顶字段。
- `0027` 为 Agent 请求保存版本化 decision envelope。
- `0028` 增加 `agent_branches`，并让请求可路由到 `project_id` / `branch_id`。

这些迁移只扩展现有 Runtime 和工作区模型，不建立第二套文档正文或第二套 Agent 执行器。

## P2 外部协议与 Outbox

Migration `0011` 为 Generated View 增加 generation/override/provenance 字段。由于 SQLite 无法直接修改 CHECK constraint，该迁移按 definition → snapshot → dependency 的依赖顺序重建并回填三表；旧 ID、当前快照和历史依赖保持不变。

`delegations.capability_token_hash` 只保存 64 位 SHA-256 hex。`allowed_operations_json` 是显式 capability allowlist；外部提交同时校验 Delegation 状态、有效期、token hash、operation、idempotency key 与 request hash。`external_submissions` 记录接受的实体，但不提供 documents 写入口。

状态事实与 `outbox_messages` 在同一 Rust transaction 中写入。worker 领取消息时写入 `lease_owner/lease_until` 并增加 attempt；进程失败后过期 lease 可重新领取。发布成功改为 `published`，失败改为 `failed` 并设置下次 `available_at`。

## 可靠性设置

连接打开后启用：

- `PRAGMA foreign_keys = ON`
- `PRAGMA journal_mode = WAL`
- `PRAGMA busy_timeout = 5000`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA temp_store = MEMORY`

Rust 为每个数据目录复用小型读写池，并为 WebView 查询维护独立只读池；WebView 不持有连接。WAL 模式提高并发读写的可靠性，只读池由 SQLite 连接级保护拒绝写语句。

移动数据目录前，Rust 会持有 Agent start gate，暂停并等待 A2A watcher、Durable Timer 和钉钉 connector，拒绝仍有活动 Run 的迁移，完整关闭空闲 sidecar，再关闭对应读写池和只读池。迁移先在目标目录内统一暂存 `editor.db`、WAL/SHM、`assets/`、`skills/`、`mcp-servers.json`、`mcp-server-exposure.json`，以及 `work_artifacts.uri` 引用且位于旧数据目录内的本地文件；暂存数据库通过完整性、外键和附件文件校验后才会启用。目标目录已有的受管内容会整体移入 `.my-notebook-backup-<timestamp>/`，任一步启用失败都会恢复该备份，避免数据库与附件处于不同版本。成功后 watcher、timer 与 Worker 绑定目标目录；失败时恢复原目录，connector 由随后一次数据库准备重新启动。

迁移会把历史遗留的绝对 `assets.relative_path` 规范化为安全的 `assets/...` 相对路径，并只重写 `work_artifacts.uri` 中位于旧数据目录内的普通本地路径或 `file:` URI。HTTP、MCP 等外部 URI、`documents.source_url` 以及 MCP 命令的 `cwd/command/args` 不会被改写。API Key 密文位于独立的系统本地数据目录，也不随知识库数据位置迁移。

## 旧版数据库加载

打开数据库前，Rust `prepare_database` 会按实际数据目录执行迁移，因此默认目录和自定义目录使用同一条版本链。对于已有 `documents` 等旧表、但没有 `_sqlx_migrations` 的早期数据库，应用会检查真实表与列，写入已存在版本的 SQLx 基线，再继续执行剩余迁移，避免重复 `ALTER TABLE`。

只要检测到已有数据库仍需升级，应用会先执行 WAL checkpoint，并在同目录创建 `editor-pre-migration-<timestamp>.db`。迁移或后处理失败时，应用会关闭连接、清理 WAL/SHM sidecar，并自动从该 snapshot 恢复当前库；snapshot 会继续保留用于人工追溯。不要手工删除迁移记录。

## 迁移问题排查

如果出现“migration N was previously applied but has been modified”，不要删除 `_sqlx_migrations`、不要手动改 checksum、不要修改现有迁移。恢复该迁移文件到已发布版本，并将新增 SQL 放在一个新的编号迁移中。

开发验证：

```bash
cd src-tauri
cargo check
```

首次打开新数据目录时会创建当前完整 schema；已有数据库只会执行尚未记录的新迁移。迁移执行成功后，再次启动不应有 schema 写操作。

## 备份

关闭应用后备份整个数据目录：`editor.db`、可选的 `editor.db-wal` 与 `editor.db-shm`、`assets/`、`skills/`、`mcp-servers.json` 和 `mcp-server-exposure.json`。若 `work_artifacts.uri` 引用了数据目录内的其他受管交付文件，也应一并备份。不要仅复制单个数据库文件后忽略 WAL 和非数据库文件。
