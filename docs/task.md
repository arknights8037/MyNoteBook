# 维护任务

最后更新：2026-07-14

## 架构维护：调用分层与去重

- [x] 统一 Rust Domain Event/Outbox 事务写入，移除三份重复 SQL。
- [x] 删除 Verifier 的非事务直写旁路。
- [x] 建立 Knowledge Control 应用协调器和单一 composition factory。
- [x] 拆分 Knowledge/View/TaskRun 页面组件，父页面只保留状态与事件编排。
- [x] 合并 Projection/Generated View 来源与依赖构建逻辑。
- [x] 按 Vue 页面/功能/应用组合边界整理前端目录，移除页面层兼容转发文件。
- [x] Agent Resource Draft 改为依赖注入，数据库与 Tauri 实现仅在 `app/composition` 组装。
- [x] 将所有 `*Page.vue` 收缩为 7～38 行的最终装配入口，完整界面状态迁入对应 feature surface。
- [x] 页面通过 composition provider 注入 Audit、Automation、Document、Transfer 与 Knowledge Control 实现；feature 不反向引用 pages。
- [ ] Windows 桌面人工 smoke test。

## 当前里程碑：架构审计与渐进改造规划

- [x] 阅读仓库说明、架构、数据库、Agent、自动化和 MCP 文档；确认仓库无 `AGENTS.md`。
- [x] 检查当前分支和未提交修改；保持用户工作区不变，不切分支、不提交、不推送。
- [x] 映射 Document、Knowledge、View、Work、Agent Runtime、Integration、Governance 七领域。
- [x] 核对 Tiptap JSON、plain text、blocks 与 FTS5 的所有权和更新链路。
- [x] 审计 Agent、Automation、Patch、Audit、Skill、Provider 和 MCP 的耦合与实现完整度。
- [x] 设计最小 Knowledge Object、View Definition、Context Bundle 和 Work 渐进映射。
- [x] 定义 P0/P1/P2 与验收标准。
- [x] 运行与本轮文档改动相符的检查并记录结果；完整前端套件暴露 1 个既有的图片插入时序失败，详见开发日志。

详细结论见 `docs/architecture-audit-2026-07-13.md`。

## 下一最小任务：P0-A Document Projection Contract

- [x] 决定并版本化 Tiptap JSON → plain text/block projection 规则。
- [x] 将 JSON 校验、派生、标签和块投影收口至 Rust Document Core transaction。
- [x] 让 Agent apply 在 Rust 内验证 Patch 归属、状态、before/target 与结果一致性。
- [x] 增加 projection rebuild/repair 命令与复杂节点、Patch 边界测试。
- [x] 新增 `0009_add_p0_trusted_runtime.sql`，不修改历史 migration。

## P0-B Trusted Runtime Foundation

- [x] MCP Server 默认不可信；本地信任与 `readOnlyHint` 同时满足才免确认。
- [x] 增加 ExecutionPolicy v1，并由 Runtime 执行工具、轮次、时间、失败和写入策略。
- [x] 增加 Context Bundle v1、来源 revision/content hash 与 snapshot hash。
- [x] 记录 Provider 实际参数/忽略参数、Skill ID/版本和 correlation/causation ID。
- [x] Skill 改为摘要注入、Agent 按需读取 `SKILL.md`。
- [x] 完整前端/Rust 回归、lint、类型检查与生产构建。
- [ ] Windows 桌面应用手工 smoke test（需实际启动并操作已迁移数据目录）。

## P1：Knowledge、Work、Verifier 与 View

- [x] 新增 migration `0010_add_p1_knowledge_work_views.sql`，建立 Knowledge Object/关系、统一 Work、Artifact/Evidence、Verifier、ChangeSet/Approval 与 View 表。
- [x] 将既有 Automation 定义/运行和 Agent 任务/Patch 通过兼容映射接入 TaskDefinition、TaskRun 与 ChangeSet，不替换历史表。
- [x] 实现 Rule、Decision、Evidence、ChangeSet 的版本、来源锚点、有效期和语义关系；Context Bundle 注入当前有效 Rule/Decision。
- [x] 实现 TaskRun 显式状态机、Artifact/Evidence 提交与 Result Verifier v1；验证结果和状态更新使用 Rust 原子事务。
- [x] 实现 Query/Projection View、历史依赖快照、stale、手工刷新以及 `readonly`/`propose_changeset` 回写策略。
- [x] 扩展 Audit，统一呈现 TaskRun、Knowledge、Verifier、ChangeSet、Approval 与 View refresh。
- [x] 增加 P1 repository/service/page 和 migration 回归测试；定向测试、类型检查及 Rust 全量测试通过。
- [ ] Windows 桌面应用 P1 手工 smoke test：升级真实数据、创建知识对象、刷新 View、执行 verifier 与审批 ChangeSet。

## 暂不进入 P1

- Generated View、自动刷新、覆盖合并或三方合并。
- A2A、MCP Server、图数据库、向量数据库或大规模文件搬迁。
- 一次性替换现有 Agent/Automation 表、Domain Event/Outbox。

## P2：外部委派与治理扩展

- [x] Generated View：生成 provenance、来源依赖、手工刷新、stale、override 保护和显式分叉文档。
- [x] 新增 Delegation capability 协议；MCP/CLI 外部 Agent 可读取冻结上下文并提交 Artifact、Evidence、Result 或 ChangeSet。
- [x] 外部提交在 Rust 中校验 token hash、授权 operation、有效期、幂等 key 和 request hash；不提供文档直写入口。
- [x] MCP Client 支持 Resources list/read；提供独立只读 stdio MCP Server 读取当前 Rule、Decision、TaskRun 和 Context Bundle。
- [x] 新增 Domain Event、Transactional Outbox、lease/retry 和统一审计分类。
- [x] Provider/Model Capability Matrix 驱动采样/Reasoning UI 与请求参数，并区分 requested/actual/ignored 参数。
- [ ] Windows 桌面 P2 手工 smoke：真实 Provider Generated View、CLI/MCP 客户端互通、Outbox 故障恢复。

## P2 明确非目标

- A2A 在 Delegation/MCP/CLI 协议稳定后再评估。
- 不实现 Generated View 自动刷新、静默覆盖、实时同步或三方自动合并。
- 不引入图数据库、向量数据库、微服务或外部消息队列。
