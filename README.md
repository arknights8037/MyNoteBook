# MyNoteBook

MyNoteBook 是基于 Vue 3、Tiptap、Tauri/Rust 和 SQLite 的本地优先知识库与受控 Agent 协作应用。文档、知识对象和 Agent 审计保存在本机；模型可以读取上下文、调用内置或 MCP 工具并提出结构化修改，但规范文档与正式知识的写入必须经过本地校验和用户确认。

## 维护文档

- [当前架构与模块边界](docs/architecture.md)：代码所有权、领域边界、真实能力和已知偏差。
- [Agent Runtime 与工具协议](docs/agent-runtime.md)：运行循环、上下文、权限、工具、审计和 Patch 确认。
- [认知系统集成设计](docs/cognitive-system-integration.md)：Cognitive Mode、知识控制模板和 Knowledge Candidate 如何复用现有架构。
- [后续开发路线图](docs/roadmap.md)：尚未完成的稳定性门禁与认知系统里程碑。
- [数据库持久化与运维](docs/database.md)：Schema 所有权、迁移、数据目录和备份恢复。
- [自动化任务与审计](docs/automations.md)：自动化定义、运行队列及当前执行边界。
- [MCP Client 与外部协议](docs/mcp-client.md)：Tools、Resources、只读 MCP Server 和 Delegation 边界。
- [工作空间视图](docs/workspace-views.md)：空间目录、文档、思维导图、幻灯片、UML/流程图和表格的当前实现边界。

以上文档只描述当前事实或明确标记的未来设计。历史实施过程不在仓库内重复维护，需要时通过 Git 历史追溯。

## 开发

```bash
pnpm install
pnpm tauri dev
```

数据库迁移只由 Rust/SQLx 在应用启动时执行。不要修改已发布的迁移文件；新增 schema 变更必须创建新的编号迁移。
