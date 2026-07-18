# 数据库持久化与运维

## 唯一 Schema 所有者

SQLite schema 只由 `src-tauri/migrations/` 中的 SQLx 迁移管理。应用启动时 Rust 端按版本执行迁移，并把 checksum 写入 `_sqlx_migrations`。

前端不再执行 `CREATE TABLE`、`ALTER TABLE` 或补列逻辑。这样避免了两个运行时同时管理 schema，防止“每次打开都提示迁移”或已应用迁移 checksum 不匹配。

**规则：已发布迁移不可修改、不可删除、不可重排。** Schema 变更必须新建下一个编号迁移。例如 `0006_add_x.sql`。历史迁移是已有用户数据的版本链，不是运行时兼容代码。

## 当前持久化内容

| 域         | 表/文件                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| 文档与层级 | `documents`；只读块投影 `blocks`                                                  |
| 标签       | `tags`、`document_tags`                                                           |
| 附件元数据 | `assets`；二进制文件位于数据库同级 `assets/`                                      |
| 本地集成文件 | `skills/`、`mcp-servers.json`、`mcp-server-exposure.json`；与数据库使用同一个可迁移数据目录 |
| 全文检索   | FTS5 `document_search` 与同步触发器                                               |
| Agent 审计 | `agent_*` 表；`agent_branches` 保存 A2A 项目分支路由，完整对话仍在 `agent_workspace_state` |
| 自动化与运行队列 | `automation_tasks`、`automation_runs`                                         |
| 上下文追溯 | `context_bundles`；Agent ExecutionPolicy、Provider 参数、Skill 版本与关联 ID |
| 结构化知识 | `knowledge_objects`、`knowledge_object_relations` |
| 认知会话与验证 | `cognitive_sessions`、`knowledge_object_sources`、`knowledge_validations` |
| 统一 Work | `task_definitions`、`task_runs`；兼容既有 Automation/Agent 表 |
| 交付与治理 | `work_artifacts`、`work_evidence`、`result_verifications`、`change_sets`、`approvals` |
| 可重建 View | `view_definitions`、`view_snapshots`、`view_dependencies` |
| 外部委派 | `delegations`、`external_submissions`、`idempotency_records` |
| 事件投递 | `domain_events`、`outbox_messages` |
| API Key    | AES-256-GCM 密文文件；随机数据密钥由系统凭据库保护，不进入 SQLite 或 localStorage |

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

前端 SQL 连接按数据库 URL 复用；Rust Agent 使用每个数据目录最多 4 个连接的小型池，避免每次工具调用重新建立 SQLite 连接。WAL 模式提高并发读写的可靠性。

移动数据目录前会关闭对应连接池。迁移先在目标目录内统一暂存 `editor.db`、WAL/SHM、`assets/`、`skills/`、`mcp-servers.json`、`mcp-server-exposure.json`，以及 `work_artifacts.uri` 引用且位于旧数据目录内的本地文件；暂存数据库通过完整性、外键和附件文件校验后才会启用。目标目录已有的受管内容会整体移入 `.my-notebook-backup-<timestamp>/`，任一步启用失败都会恢复该备份，避免数据库与附件处于不同版本。

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
