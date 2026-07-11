# MyNoteBook

本地优先的桌面知识库与受控 Agent 编辑器。文档与 Agent 审计记录保存在本机 SQLite；模型只能提出修改，用户确认后才会写入。

## 文档

- [Agent Runtime 与工具协议](docs/agent-runtime.md)
- [数据库持久化与运维](docs/database.md)

## 开发

```bash
pnpm install
pnpm tauri dev
```

数据库迁移只由 Rust/SQLx 在应用启动时执行。不要修改已发布的迁移文件；新增 schema 变更必须创建新的编号迁移。
