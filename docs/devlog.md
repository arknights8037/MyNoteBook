# 开发日志

## 2026-07-14：页面入口纯装配化

### 实现

- 将 Home、Audit、Automation、Knowledge Control、Plugin/Skill 和 Settings 的完整界面控制器迁入对应 `src/features/*/components/*Surface.vue`。
- `src/pages` 中生产页面缩减为 7～38 行，只选择 composition provider、注入依赖及转发公开 props/events。
- 新增 `surfaceServiceProviders.ts`，集中提供缓存的 Audit Repository、Automation Service、Document Service 与 Document Transfer Service。
- Workspace 不再导入其他 page；它直接组合 sibling feature surface，并从 Home page 接收具体服务 provider。
- `pages/home` 与 `pages/settings` 私有模块分别归入 workspace/settings feature；Document Transfer composable 不再自行动态选择 Tauri adapter。

### 验证

- `pnpm typecheck` 与 `pnpm build`：通过。
- 页面装配与迁移模块定向回归：6 个测试文件、9 项测试通过。
- `pnpm test:run`：92 个测试文件通过、1 个跳过；323 项通过、2 项跳过。首轮仅复现既有 EditorShell 图片时序抖动，隔离复验及第二次全量通过。
- `pnpm lint`：0 error、保留既有 `AiChatPanel.vue` `v-html` 警告；跨层依赖搜索与 `git diff --check` 通过。

## 2026-07-14：Vue 前端目录与依赖方向整理

### 实现

- `src/pages` 仅保留页面入口及 `home`、`settings` 页面私有模块；AI Chat、Document、Knowledge Control 与 MCP 功能组件迁入对应 `src/features`。
- Document 文件规则、列表状态、展示投影和树算法连同测试归入 `features/documents`，删除页面层的兼容 re-export。
- Knowledge Control 工厂迁入 `src/app/composition`；`AgentResourceDraftService` 改为注入 Automation/Skill 端口，新增 composition factory 连接数据库仓储与 Tauri Skill API。
- 更新所有生产代码和测试引用；低层模块不再引用 pages，services 不再直接引用 infrastructure。

### 验证

- `pnpm typecheck` 与 `pnpm build`：通过。
- 定向回归：9 个测试文件、23 项测试通过。
- `pnpm test:run`：92 个测试文件通过、1 个跳过；323 项通过、2 项跳过。首轮复现既有 EditorShell 图片用例时序抖动，隔离复验及第二次全量均通过。
- `pnpm lint`：0 error、保留既有 `AiChatPanel.vue` `v-html` 警告；`git diff --check` 通过。

## 2026-07-14：分层与重复代码审查

- 将 Work、View、Governance 中三份重复的 Domain Event/Outbox SQL 合并到 Rust `domain_events`，统一 actor、correlation、causation 和事务写入规则。
- 删除未被生产调用且绕过 Rust 原子提交的 `WorkRepository.saveVerification` 直写入口；Verifier 只保留 `finalizeVerification`。
- 新增 `KnowledgeControlService` 应用协调器和单一 composition factory，页面不再为每个操作重复实例化 repository/service。
- 将知识对象、View、TaskRun/CLI 三块界面拆为独立 Panel；父页面以统一 `execute/reload` 状态机编排事件。
- 合并 Projection/Generated View 重复的 Document/Knowledge 来源加载和 dependency 投影逻辑。
- 将 Playwright `test-results` 生成目录加入 `.gitignore` 并删除工作区生成物。
- 验证：前端 92 个测试文件通过、1 个跳过（323 项通过、2 项跳过）；Rust 29 项通过、1 项系统凭据诊断忽略；typecheck、生产构建、Rust format 通过；lint 0 error、保留既有 `v-html` 警告。

## 2026-07-14：P2 External Delegation、Governance 与 Generated View

### 实现

- 新增 migration `0011_add_p2_external_governance_generated_views.sql`，扩展 View 约束与 provenance，并增加 `delegations`、`idempotency_records`、`external_submissions`、`domain_events`、`outbox_messages`。
- Generated View 记录 Provider、model、Skill 版本、generation time、correlation/causation 与来源 snapshot；存在手工 override 时刷新只产生 protected preview，不更新当前快照。
- View writeback 完整支持 readonly、propose_changeset 和用户显式 fork_document；分叉走普通 Document Core 创建链路。
- Delegation capability token 仅首次返回明文，SQLite 只保存 SHA-256；外部提交由 Rust 单事务完成授权、过期、幂等、实体、Domain Event 与 Outbox 写入。
- Outbox 支持 worker lease、超时重新领取、发布确认、失败退避和 attempt count。
- MCP Client 增加 Resources list/read；新增 `mynotebook-mcp` 只读 stdio Server。CLI Adapter 使用版本化 JSON envelope 导出 TaskRun/Context Bundle 并导入提交。
- Provider Capability Matrix 覆盖 sampling、reasoning、reasoning content、tool choice、structured output、message role、streaming 与 token 上限；设置页和聊天页隐藏不支持的参数。
- Audit 增加 Delegation、Domain Event 与 Outbox 分类。

### 安全与兼容性

- 不修改 `0001`～`0010`；`0011` 重建 View 三表以扩展 CHECK constraint，并完整回填历史 definition/snapshot/dependency。
- MCP Server 执行 `PRAGMA query_only = ON`，不暴露写工具；外部写入只能使用受限 Delegation submission。
- 外部 result 将 TaskRun 推入 `blocked` 等待独立 Verifier，不会标记完成；ChangeSet 仍需 Approval 和既有 Patch/Document Core 原子应用。
- Idempotency key 重放仅在 request hash 相同时返回原结果；相同 key 的不同请求被拒绝。

### 验证进度

- v9→v10→v11 View 数据保留、Generated View constraint 与 P2 表检查通过。
- `cargo test --no-fail-fast`：29 项通过、1 项系统凭据诊断测试忽略；独立 MCP Server binary target 已编译；`cargo fmt --check` 通过。
- `pnpm test:run`：91 个测试文件通过、1 个跳过；321 项通过、2 项跳过。
- `pnpm typecheck` 与 `pnpm build`：通过；保留依赖 PURE annotation、混合导入和 chunk size 警告。
- `pnpm lint`：0 error、1 个既有 `AiChatPanel.vue` `v-html` 警告。
- 未执行 Windows 桌面/真实外部 Agent/真实 Provider 手工 smoke test。

## 2026-07-14：P1 Knowledge、Work、Verifier 与 View

### 实现

- 新增 migration `0010_add_p1_knowledge_work_views.sql`：Knowledge Object/关系、TaskDefinition/TaskRun、Artifact/Evidence、Result Verification、ChangeSet/Approval、View Definition/Snapshot/Dependency。
- Rule、Decision、Evidence 和 ChangeSet 使用版本化窄模型并锚定 document/block/revision；Agent Context Bundle 会记录当前有效 Rule/Decision。
- Result Verifier v1 校验 Artifact/Evidence、测试报告、来源 revision 和人工审批要求，只能推进 TaskRun 或提出 ChangeSet，不直接修改正式知识或文档。
- View v1 支持 Query/Projection、手工刷新、SHA-256 来源快照、当前快照 stale 判定及 `readonly`/`propose_changeset`；历史快照依赖不会被后续刷新覆盖。
- Rust command 原子提交 verifier 结果、TaskRun 状态、ChangeSet/Approval 和 View refresh；知识控制页面提供 P1 最小操作面。
- Audit 新增 task run、knowledge、verification、change set、approval 与 view refresh 分类。

### 兼容性

- 未修改 `0001`～`0009`；旧数据库只追加 `0010`。
- `automation_tasks`/`automation_runs` 映射为统一定义/运行，`agent_tasks` 映射为 TaskRun，既有 Patch set/transaction 映射为 ChangeSet；旧表和 API 保留。
- Agent 单 Patch 接受/拒绝不再误判整个 ChangeSet；仅全局 applied 或 reject-all 决定集合状态。
- View stale trigger 仅检查 `current_snapshot_id` 指向的依赖，保留历史 snapshot/dependency provenance。

### 验证进度

- migration：v9→v10 历史 Work 映射、View 当前快照 stale 触发通过。
- `cargo test --no-fail-fast`：27 项通过、1 项系统凭据诊断测试忽略；`cargo fmt --check` 通过。
- P1 定向前端：10 个测试文件、23 项测试通过；`pnpm typecheck` 通过。
- `pnpm test:run`：88 个测试文件通过、1 个跳过；313 项通过、2 项跳过。
- `pnpm lint`：0 error、1 个既有 `AiChatPanel.vue` `v-html` 安全警告。
- `pnpm build`：通过；保留依赖 PURE annotation、动态/静态混合导入与 chunk size 警告。
- 未执行 Windows 桌面应用 P1 手工 smoke test。

## 2026-07-13：P0 Trusted Foundation

### 实现

- 新增 Rust `document_core`：Tiptap JSON/稳定 block ID 校验、确定性纯文本与块投影、文档/标签/blocks 原子保存、全库或单文档投影修复。
- 普通 DocumentRepository 保存改走 Rust command；`plainText` 输入仅保留前端兼容，不再决定数据库派生值。
- Rust Agent apply/creation/rollback 复用 canonical projection，并复核任务状态、文档归属、完整 Patch 决策、revision、target、before 和接受结果。
- 新增 migration `0009_add_p0_trusted_runtime.sql`：`context_bundles`、Agent provenance、tool/automation correlation 与 causation 字段；旧记录用现有实体 ID 回填 correlation ID。
- 新增 ExecutionPolicy v1 和 Context Bundle v1；Bundle 记录来源 revision/content hash、权限、编译策略、目标模型与 SHA-256 snapshot hash。
- MCP 配置新增本地 `trusted`，默认 false；annotation 不再单独免授权。
- Skill 改为只注入摘要，运行时按需读取正文，并记录启用 Skill 版本。

### 兼容性

- 未修改 `0001`～`0008`；已有数据库只追加 migration `0009`。
- MCP 旧配置缺少 `trusted` 时默认映射为 false，安全降级，不会自动信任。
- Agent/Automation 历史数据保留，新增 JSON/关联字段有安全默认值并回填 correlation ID。
- 旧文档不会在 migration 中批量重写；显式 projection repair 遇到无法验证的历史正文只报告错误。

### 验证进度

- `cargo test --no-fail-fast`：26 项通过、1 项需要系统凭据的诊断测试忽略。
- migration：全新数据库 0001→0009 通过；真实 v8 schema 执行 0009、历史 correlation ID 回填通过。
- `pnpm test:run`：83 个测试文件通过、1 个跳过；305 项通过、2 项跳过。
- `pnpm typecheck`：通过。
- `pnpm lint`：0 error、1 个既有 `AiChatPanel.vue` `v-html` 安全警告。
- `pnpm build`：通过；保留既有 chunk size 和动态/静态混合导入警告。
- `cargo fmt --check`：通过。
- 未执行 Windows 桌面应用手工 smoke test。

## 2026-07-13：首次架构接管审计

### 完成

- 检查 Vue/Tiptap/Tauri/Rust/SQLite 实际模块、8 个 SQLx migration、数据访问边界及现有测试分布。
- 确认 `documents.content_json` 是设计上的规范正文；`plain_text`、`blocks`、FTS5 为派生查询数据，但 plain text 目前仍由调用方双写。
- 确认 Patch/Diff/确认/原子写入/revision 撤销和 MCP Tools Client 等为真实实现。
- 确认 View 目前只是普通文档模板；Knowledge Object、Context Bundle、Result Verifier、统一 Work/Governance 尚未实现。
- 记录 Rust Agent apply 校验不足、标签非事务同步、投影缺少重建入口、MCP `readOnlyHint` 直接免授权、Skill 全量注入和 Provider capability 缺失等风险。
- 新增 `docs/architecture-audit-2026-07-13.md` 和本任务/日志文件。

### 变更边界

- 无业务代码修改。
- 无数据库 migration。
- 无数据迁移或旧数据格式变化，因此旧数据兼容性不受影响。
- 当前在 `main` 且已有大量用户未提交改动，本轮没有切分支、提交或推送。

### 验证

- `git diff --check -- docs/...`：通过；审计文档引用的仓库路径均存在。
- `pnpm typecheck`：通过。
- `cargo test`：21 项通过，1 项需要系统凭据的诊断测试忽略。
- `pnpm test:run`：连续两次均为 81 个测试文件通过、1 个跳过、1 个失败（303 项通过、2 项跳过、1 项失败）。失败固定为 `src/editor/EditorShell.test.ts` 的“inserts an image and keeps its editable caption in document JSON”，完整套件中 `imageNode` 为 `undefined`。
- 单独运行上述失败用例：通过（1 项通过、20 项按过滤条件跳过）。这表明用例受完整套件并发或时序影响；本轮未修改该测试或编辑器代码，记录为既有测试稳定性问题，不在审计轮次中修复。

### 后续

推荐下一步为 P0-A Document Projection Contract；先收口可信写入和派生规则，再建设 Knowledge/View schema。
