# 架构审计与渐进改造规划（2026-07-13）

> 实施状态：本文第 10 节 P0 已于 2026-07-13 完成；P1 与 P2 最小切片已于 2026-07-14 实现。实际范围与验证记录见 `docs/devlog.md`；A2A、自动 View 合并等扩展仍未进入。

## 1. 审计范围与结论

本轮按长期维护视角检查了以下实际实现：

- 项目约定与说明：`README.md`、`AGENT_MVP_TRACKING.md`、`docs/architecture.md`、`docs/agent-runtime.md`、`docs/automations.md`、`docs/database.md`、`docs/mcp-client.md`；仓库当前不存在 `AGENTS.md`。
- Document Core：`src/editor`、文档 model/service/repository/autosave、`src-tauri/src/database.rs`、`src-tauri/src/agent_repository.rs`、迁移 `0001`～`0007`。
- Agent Runtime：`src/composables/useAgentRun.ts`、`src/composables/agentRun`、`src/services/Agent*`、`src/services/AiSdk*`、`src-tauri/src/agent_tools.rs`。
- Work 与 Governance：Agent/Automation/Audit model、service、repository、页面和迁移 `0004`、`0005`、`0007`、`0008`。
- Integration：Skill、MCP、Provider 的 TypeScript/Rust 实现及配置页面。
- View：`CreateViewModal.vue`、`viewTemplates.ts`、`HomePage.vue#createAndOpenView`。

总体判断：项目已经具备可信文档修改闭环、可恢复 Agent Patch、FTS5 检索、受限工具、Skill、MCP Client、自动化队列和聚合审计等真实实现，不是纯界面原型；但它仍是以“文档编辑 + Agent 会话”为中心的 MVP。Knowledge Object、真正的 View Domain、统一 Work 模型、Context Bundle、Result Verifier、Domain Event/Outbox 和 Provider Capability Matrix 尚未实现。

本轮不实施数据库或业务代码改动。原因是当前 `main` 上有大量用户未提交修改，而审计发现的前置问题涉及写入可信边界、数据派生规则和 MCP 授权语义，不属于适合夹带在审计轮次中的低风险修补。

## 2. 七领域现状映射

| 目标领域 | 当前主要实现 | 完整度与边界 |
| --- | --- | --- |
| Document | `src/editor`；`DocumentService`；`TauriDocumentRepository`；`documents`、`blocks`、`assets`、`tags`、`document_tags`、`document_search`；Rust Agent 写入事务 | 核心闭环真实可用；写模型声明明确，但派生数据生成尚未完全收口到可信边界 |
| Knowledge | 文档元数据、标签、`knowledgeRetrieval.ts`、`agent_task_sources` | 只有检索和来源记录；没有 Decision/Rule/Goal/Task/Evidence/ChangeSet 对象及关系/生命周期 |
| View | `CreateViewModal.vue`、`viewTemplates.ts` | 仅把四种模板创建成普通文档；没有 View Definition、依赖快照、stale、provenance、refresh/writeback policy |
| Work | `agent_tasks`/`agent_tool_calls`；`automation_tasks`/`automation_runs`；对应 service/repository | 两套独立模型；Agent task 实际更接近一次 AgentRun，Automation task 更接近 TaskDefinition |
| Agent Runtime | `useAgentRun`、`AiSdkAgentRuntime`、`AgentToolRegistry`、`AgentToolExecutor`、AI SDK provider | 多轮工具、超时、取消、修复输出真实可用；执行策略仍为全局常量，且 Runtime/资源草稿/授权编排存在耦合 |
| Integration | Rust `mcp.rs`、`skills.rs`，TS `McpService`/`SkillService`/`AiSdkProvider` | MCP Tools Client 与 Skill 文件管理真实可用；无 Resources/MCP Server/CLI Adapter/A2A；信任策略不足 |
| Governance | confirmations、文档事务、Audit 聚合查询、Stronghold/白名单 | 有审计记录与审批门禁；没有统一 Policy/Approval/Event/Outbox/idempotency/correlation 模型 |

依赖方向大体遵守 `docs/architecture.md`：UI → composable/service → repository contract → infrastructure。但以下属于明确例外或过渡性耦合：

- `TauriAgentRepository` 既通过前端 SQL 直接写任务/工具审计，又通过 Rust command 执行 Patch 事务，并在内部实例化 `TauriDocumentRepository`。
- `SkillService`、`McpService`、`AiModelService` 等 service 直接依赖 Tauri `invoke`，尚未形成 Integration Gateway port/adapter。
- `AssetService` 直接取得数据库连接，虽然位于 infrastructure，仍绕过了 Document repository 的统一事务边界。
- `HomePage.vue` 仍承担文档、Agent、视图模板和多个工作流的组合热点。

## 3. 文档数据所有权与更新链路

### 3.1 当前链路

```text
Tiptap Editor
  -> useDocumentAutosave.getSnapshot()
  -> serializeEditorContent(content) + editor.getText/plainText
  -> TauriDocumentRepository.save()
  -> documents(content_json, plain_text, revision)
       -> blocks_after_document_* trigger -> blocks
       -> documents_search_after_* trigger -> document_search (读取 documents.plain_text)
```

Agent 写入链路：

```text
模型输出 command/patch
  -> TypeScript schema 与块/revision/before 校验
  -> Diff/用户确认
  -> 前端应用 Patch，生成完整 contentJson + plainText
  -> Rust apply_agent_patch_set()
  -> 单一 SQLite transaction：文档更新 + Patch 状态 + confirmation + transaction snapshot + task 状态
  -> 同事务 SQLite trigger 刷新 blocks 与 FTS5
```

撤销链路由 `rollback_agent_transaction()` 使用快照和 resulting revision 保护；如果 Agent 写入后已有新 revision，会拒绝覆盖。这部分是可恢复的真实实现。

### 3.2 所有权判断

- 规范正文应为 `documents.content_json`，且类型为 Tiptap `doc`；稳定 block ID 存在于顶层节点 `attrs.id`。
- `blocks` 是可重建的顶层块查询投影，SQLite trigger 在插入、正文/revision/删除状态变化时重建。
- `documents.plain_text` 是派生查询投影，但当前仍由调用方提供并与 JSON 同时写入。
- `document_search` 是从 `documents.title/plain_text` 同步的 FTS5 投影。
- `revision` 是文档级乐观并发版本，也是 Patch 和撤销安全判断的基础。

### 3.3 双写与不可恢复风险

1. **`content_json` 与 `plain_text` 仍是调用方双写。** `SaveDocumentInput`、`ApplyAgentPatchSetInput` 和 Rust command 都同时接受两者；数据库没有校验二者一致。只要任一调用路径提交不一致值，FTS5、字符数、Agent `read_document` 与真实 Tiptap 内容就会漂移。
2. **Rust 写入边界没有重新校验 Patch 语义。** `apply_agent_patch_set()` 只校验 document revision，随后接收前端给出的完整 JSON/纯文本并更新 Patch 状态；它没有验证 task/patch 当前状态、patch 所属文档、`before_text`、目标 block、accepted Patch 是否确实产生该 JSON，也不解析/规范化 Tiptap JSON。TypeScript 校验对 UX 有价值，但不能替代可信写边界。
3. **`blocks.plain_text` 的 SQL JSON 遍历规则不是完整 Tiptap 文本语义。** 它拼接 `text` 节点并特判 `attrs.latex`，复杂表格、附件和自定义节点的投影语义可能与编辑器 `plainText` 不同。
4. **标签同步不是文档保存事务的一部分。** `TauriDocumentRepository.save/update/create` 先写文档，再逐条删除/插入 `document_tags`；中途失败可留下“正文已保存、标签部分更新”的状态。
5. **投影可重建机制只有触发器，没有显式 repair/rebuild 命令。** `blocks` 与 FTS5 理论可恢复，但一旦历史漂移，目前没有版本化 projector 或一致性检查入口。
6. **硬删除可能被审计外键阻止。** `agent_document_transactions.document_id` 使用 `ON DELETE RESTRICT`；这是保护审计的合理选择，但 UI/服务需要明确把“被审计文档不可永久删除”作为产品规则或改为保留 tombstone，不能把数据库错误当偶发失败。

结论：当前不是两套可独立编辑的正文 UI，但数据库 API 仍允许 JSON/纯文本成对双写；因此“唯一规范写模型”已形成设计意图，尚未形成不可绕过的数据边界。

## 4. Work、Runtime、Patch、审计与 Integration 耦合

### 4.1 重复任务模型

- `agent_tasks`：字段含 session/document、instruction、model、current step，状态为 `pending/running/waiting_confirmation/completed/failed/cancelled`。它没有 definition、acceptance criteria、assignee、trigger 或独立 AgentRun，因此当前记录实际同时承担 TaskRun 与 AgentRun。
- `automation_tasks`：保存指令、触发配置、文档绑定和排期，语义上接近 TaskDefinition。
- `automation_runs`：保存冻结输入与队列状态，语义上接近 TaskRun，但没有对应 AgentRun、验收、Artifact/Evidence/Approval/ChangeSet。
- 自动化 run 当前不会调用 Agent Runtime；`AutomationService` 只支持入队和人工推进状态。

### 4.2 状态、幂等与审计

- `automation_runs` 的部分唯一索引能阻止同一 automation 同时出现多个 queued/running run，这是有效的并发去重。
- `updateRunStatus()` 不校验合法前置状态，completed run 可被重新改为 running；没有 lease/attempt/idempotency key。
- `agent_tool_calls` 以 ID upsert，具有局部幂等性；Agent task 状态更新不校验状态迁移。
- Audit 页面是对四类表的 `UNION ALL` 查询视图，不是不可变审计事件流；没有 actor、policy decision、correlation/causation ID，也没有分页/保留策略。
- Patch apply/rollback 的数据库事务和 revision 防护是真实的强项；但 Approval 仍编码在 `agent_confirmations`，不是可复用的治理对象。

### 4.3 Runtime 耦合

- `AiSdkAgentRuntime` 同时注册内置知识工具、授权工具、资源草稿工具和 MCP 工具；资源草稿虽然有确认，但已经超出纯模型/工具循环的最小职责。
- 最大 6 轮、最多 2 次工具失败、5 分钟超时位于 `AgentToolRegistry.ts` 全局常量，不是每个任务可追溯的 ExecutionPolicy。
- `/plan`、`/research` 等 intent 已作为运行预设存在，这是正确方向；但它们仍直接影响 Runtime 的强制 tool choice 和最终输出归一化。
- 运行记录保存 task、tool calls、sources 和 patch，但没有实际发送参数、忽略参数、Skill 版本、provider capability、context snapshot/hash。

### 4.4 MCP 与 Skill

- MCP stdio/Streamable HTTP、初始化、tools/list、call、30 秒超时和会话关闭均为真实实现；Resources 等尚未实现。
- **当前 MCP 授权存在 P0 风险：** Rust 把服务自报的 `readOnlyHint` 映射为 `readOnly`，TS `createMcpRuntimeTools()` 据此设置 `requiresConfirmation = false`。本地配置没有 `trusted` 或 policy 字段，违反“annotation 只能作为风险参考”的目标边界。
- MCP `env`/HTTP headers 明文保存在 `mcp-servers.json`，文档已经如实声明该限制。
- Skill 有 frontmatter 的 name/description/version、启停、校验、安全相对路径和按需文件读取；但 `loadEnabledSkillPrompt()` 仍把全部启用 Skill 的 `SKILL.md` 正文最多 48,000 字符注入每次系统提示。没有 intent/trigger/tool/permission/dependency/priority/trust manifest，也没有记录某次运行实际使用的 Skill 版本。

### 4.5 Provider

Provider 接入和基本参数适配是真实实现，但 Capability Matrix 尚不存在：

- UI profile 对所有 provider 暴露统一的 temperature、topP、reasoningEffort、maxTokens。
- `AiMarkdownService` 用 provider/model 条件分支过滤部分参数；AI SDK Runtime 又走另一套适配路径。
- 没有持久化“用户配置 / 实际发送 / 被忽略参数”，也没有 tool choice、structured output、消息角色、streaming、上下文/输出上限的统一能力描述。

## 5. 已完整、部分和占位能力

### 已形成可运行闭环

- Tiptap 文档、稳定块 ID、revision autosave、软删除/恢复。
- FTS5 搜索和来源块跳转。
- Agent 多轮工具调用、取消/超时、失败记录和输出修复。
- Patch/Diff/确认/Rust 原子写入/revision 冲突/事务撤销/重启恢复。
- Skill 创建导入、启停、校验、安全文件读取。
- MCP Tools Client（stdio 与 Streamable HTTP）。
- 自动化定义、到期查询、去重入队、运行记录与聚合审计页面。

### 部分实现

- Document Core：核心可靠，但规范 JSON 到所有派生投影的单向编译边界未收口。
- Knowledge：只有文档、标签、检索来源，不是结构化知识对象。
- Work：Agent 与 Automation 各自可用，但没有统一定义/运行/委派/验收模型。
- Governance：有确认、事务、审计和安全白名单，没有统一策略/事件/关联链。
- Provider/Skill：有实用功能，缺 capability/manifest 选择与运行 provenance。

### 界面模板或尚未实现

- “新建视图”只是把 Markdown 模板解析为普通文档，flowchart/slides/plan 不是 View Domain 实例。
- 没有 Query/Projection/Generated View 的 definition、refresh、stale、override 或 ChangeSet writeback。
- 没有 Decision、Rule、Goal、Task、Evidence、ChangeSet 表。
- 没有 Context Bundle 和 Result Verifier。
- 没有 MCP Resources、MCP Server、CLI Agent Adapter、A2A。
- 没有 Domain Event、Transactional Outbox、统一 correlation/causation ID。
- `tests/e2e` 没有真实纵向用例；Windows 干净安装与 Provider 实账号回归仍未完成。

## 6. 最小 Knowledge Object 模型（设计，不在本轮迁移）

第一步采用窄表 + 关系表，不复制正文，不引入图数据库：

```text
knowledge_objects
- id TEXT PK
- object_type TEXT          # decision | rule | goal | task | evidence | change_set
- status TEXT               # draft | candidate | approved | active | deprecated
- title TEXT
- owner_id TEXT NULL
- scope_json TEXT           # 有版本的结构化作用域
- document_id TEXT NULL FK documents
- block_id TEXT NULL        # 与 document_id 组成来源锚点
- source_revision INTEGER NULL
- authority_level TEXT
- confidence REAL NULL
- valid_from INTEGER NULL
- valid_until INTEGER NULL
- verified_at INTEGER NULL
- version INTEGER
- created_at / updated_at INTEGER
```

```text
knowledge_object_relations
- id TEXT PK
- from_object_id TEXT FK
- relation_type TEXT        # supersedes | conflicts_with | supports | derives_from | relates_to
- to_object_id TEXT FK
- created_at INTEGER
- UNIQUE(from_object_id, relation_type, to_object_id)
```

约束：正文继续只存在于 Tiptap JSON；对象引用 block 和 revision。需要对象自身结构化字段时放入经 schema/version 校验的窄 JSON，而不是复制整段正文。`block_id` 当前不是全局唯一，所有引用必须同时保存 `document_id`。

## 7. 最小 View Definition 模型（设计，不在本轮迁移）

```text
view_definitions
- id TEXT PK
- name TEXT
- view_type TEXT            # query | projection | generated
- scope_query_json TEXT
- projection_schema_json TEXT NULL
- render_spec_json TEXT
- refresh_policy TEXT       # manual 起步
- writeback_policy TEXT     # readonly | propose_changeset | fork_document
- target_document_id TEXT NULL
- version INTEGER
- created_at / updated_at INTEGER
```

```text
view_snapshots
- id TEXT PK
- view_id TEXT FK
- status TEXT               # fresh | stale | generating | failed
- source_snapshot_hash TEXT
- generated_document_id TEXT NULL
- provider TEXT NULL
- model TEXT NULL
- skill_versions_json TEXT
- generated_at INTEGER NULL
- manual_override INTEGER
- error TEXT NULL
```

```text
view_dependencies
- snapshot_id TEXT FK
- source_type TEXT          # knowledge_object | document_block
- knowledge_object_id TEXT NULL
- document_id TEXT NULL
- block_id TEXT NULL
- source_revision INTEGER
- PRIMARY KEY(snapshot_id, source_type, ...)
```

初始实现只做 manual refresh；源文档 revision 变化时标记 stale。Generated View 若 `manual_override=1`，刷新只能产生新预览/ChangeSet，不能覆盖目标文档。

## 8. TaskDefinition、TaskRun、AgentRun 渐进映射

不重命名现有表，不一次迁移历史数据：

1. 新增统一 ID 层和适配读取：`automation_tasks -> TaskDefinition(trigger=schedule/manual)`；`automation_runs -> TaskRun`；现有交互式 `agent_tasks` 暂视为 `AgentRun`，并保留兼容 API。
2. 新 TaskRun 可选引用 `task_definition_id`；交互式一次性任务允许 definition 为空并保存冻结 instruction/acceptance criteria。
3. 给 `agent_tasks` 增加可空 `task_run_id`，新运行双向关联；历史 Agent task 按需惰性映射，不强制回填伪造 TaskRun。
4. `agent_tool_calls`、Patch、Approval、Artifact/Evidence、ChangeSet 均引用 `agent_run_id/task_run_id`，并加入 correlation/causation ID。
5. 等所有新写入走统一模型后，再把 `agent_tasks` 的 UI 名称改为 Agent Run；旧表保留到兼容窗口结束。

建议统一状态超集：`queued/running/waiting_input/waiting_approval/blocked/completed/failed/cancelled/timed_out/stale`。各实体通过显式状态机限制子集，不允许 repository 任意覆盖状态。

## 9. Context Bundle 最小结构

```text
ContextBundle v1
- id
- taskRunId
- agentRunId / delegationId
- actorId + permissionSnapshot
- goalRef
- scope
- executionPolicyRef
- sources[]:
    kind, knowledgeObjectId?, documentId, blockId?, revision,
    authorityLevel?, confidence?, contentHash
- activeRules[]: knowledgeObjectId, version, source anchor
- decisions[]: knowledgeObjectId, version, source anchor
- conflicts[]: leftRef, rightRef, disposition
- compiler:
    strategy, version, query, ranking, truncation, tokenBudget, targetModel
- createdAt
- snapshotHash
```

P0 可先把当前 `buildAgentRunContext()` 的输出升级为内存结构并持久化 metadata/hash，不立刻复制全文。Bundle 必须不可变；正文通过 `(document_id, block_id, revision)` 可追溯，必要时另存冻结片段或内容哈希以处理历史 revision 当前未保留全文的问题。

## 10. 里程碑与验收标准

### P0：收口可信写入与可追溯上下文

范围：不引入完整 Knowledge/View Engine，先让现有基础成为可靠地基。

- 在 Rust Document Core 建立单一写命令：校验/规范化 Tiptap JSON，由 JSON 确定性生成 `plain_text`；普通保存与 Agent 写入复用同一规则。
- Rust apply 重新校验 task/patch 状态、归属、revision、target/before，并拒绝调用方提交与 accepted Patch 不一致的结果。
- 增加投影一致性检查/重建入口与复杂节点测试；标签同步进入事务。
- MCP 增加本地 trust/policy，未明确可信的 Server 即使声明 readOnly 也需要授权。
- 引入 ExecutionPolicy v1 和 Context Bundle v1；Agent Run 记录 policy、provider/model、实际参数、Skill 版本与 bundle ID。
- 为新字段增加 correlation/causation ID，但先不建设完整 Event Bus。

验收：构造 JSON/plainText 不一致或伪造 Patch 的 Tauri 调用会失败；普通保存、Agent apply、rollback 后 JSON/plainText/blocks/FTS 一致；未信任 MCP readOnly 工具必经授权；同一 Context Bundle 可验证 snapshot hash 并定位所有来源 revision；现有数据库升级、保存、搜索、Patch、撤销回归通过。

### P1：最小 Knowledge、Work 与验证闭环

- 增加 `knowledge_objects`/relations，先落地 Rule、Decision、Evidence、ChangeSet；对象锚定现有文档块。
- 新增 TaskDefinition/TaskRun/AgentRun 关联与显式状态机，把 Automation 通过 adapter 接入统一 Work 读取模型。
- 引入 Artifact/Evidence 与 Result Verifier v1；验证只改变 TaskRun 状态或提出 ChangeSet。
- 实现 Query/Projection View definition、dependency snapshot、stale 和 manual refresh；仅支持 readonly/propose_changeset。
- Audit 查询升级为统一关联视图，记录 Approval 与 verifier result。

验收：一个由 Rule/Decision 生成的 TaskRun 能编译 Bundle、运行 Agent、提交 Artifact/Evidence、由 verifier 判定、生成并审批 ChangeSet、原子更新文档并刷新 View stale 状态；旧 automation/agent 历史仍可查看。

### P2：外部委派与治理扩展

- Generated View provenance、override 保护和手动刷新。
- MCP Resources Client 与只读 MCP Server；外部 Agent 可取版本化 Bundle、读任务、提交 Artifact/Evidence/结果/ChangeSet。
- CLI Agent Adapter；A2A 仅在上述协议稳定后评估。
- Domain Event + Transactional Outbox、幂等 consumer、统一 Policy/Approval。
- Provider Capability Matrix 驱动 UI、请求适配和运行审计。

验收：外部 Agent 无法绕过本地权限或 ChangeSet；重复提交由 idempotency key 去重；outbox 故障恢复不丢事件；Generated View 在来源变更后 stale，用户 override 不被刷新覆盖；Provider UI 只展示模型支持的参数。

## 11. 推荐的下一个最小里程碑

先执行 **P0-A：Document Projection Contract**，控制在一个 migration 和一个 Rust 写入模块内：

1. 固化 Tiptap JSON → plain text/block projection 的版本化规则与 fixture。
2. 给 Rust 新建 `document_core` 写入函数，Agent apply/rollback 先复用；普通前端 autosave 随后切换。
3. 增加一致性检测与 rebuild 测试，不改变用户可见功能。
4. 同一个分支内完成 MCP trust 修复可作为独立 P0-B，避免与文档写模型混成一次提交。

这是 Context Bundle、Knowledge Object 和 View dependency 能可靠引用 revision/block 的必要前置；在它完成前不建议创建 View/Knowledge migration。
