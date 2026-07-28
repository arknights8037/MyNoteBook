# 协作开发规范

MyNoteBook 是 Vue 3 + Rust/Tauri 的本地优先桌面应用。协作开发以短分支、小型 PR、领域端到端所有权和可重复的自动门禁为基础。

## 开发准备

需要 Node.js 24、pnpm 10.12.4、Rust stable 和 Windows WebView2。安装依赖：

```powershell
pnpm install --frozen-lockfile
```

本地启动：

```powershell
pnpm tauri dev
```

开发服务器固定使用 `127.0.0.1:1420`。同一台机器同时使用多个 worktree 时，只允许一个 worktree 启动完整 Tauri 应用；其他 worktree 运行类型检查、单元测试和 Rust 测试。

## 分支与提交

- 从最新 `main` 创建短期分支，建议使用 `feat/`、`fix/`、`refactor/` 或 `docs/` 前缀。
- 一个 PR 只解决一个问题，避免把格式化、重构和功能修改混在一起。
- 每天同步 `main`；遇到公共热点文件时尽早协调，不要等到合并前集中处理冲突。
- 禁止直接向 `main` 推送；通过 PR 合并，并保持提交可独立审查和回滚。

## 模块所有权

优先按端到端领域划分任务：

| 领域             | 主要目录                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| 文档与编辑器     | `src/editor`、`src/features/documents`、对应 services/repositories、`src-tauri/src/document_core.rs`        |
| Workspace 与视图 | `src/features/workspace*`、`src/features/mind-map`、workspace models/repositories、`src-tauri/src/views.rs` |
| Agent、AI 与认知 | agent/ai/cognitive models、services、composables，以及对应 Rust runtime                                     |
| 平台与集成       | `src/app/composition`、`src/ui`、`src/styles`、`src-tauri/src/lib.rs`、database、migrations 和锁文件        |

`src-tauri/src/lib.rs`、`src/styles`、两个锁文件和 migration 是公共热点。修改前应在 PR 或任务中声明，并由 CODEOWNERS 中的集成负责人复核。

## 数据库迁移

- 已发布 migration 不得修改、删除或重排。
- Schema 变化只能新增 migration。
- 新建 migration 前先在任务或 PR 中预约下一个编号，避免并行分支使用相同版本号。
- 新 migration 必须同步登记到 `src-tauri/src/lib.rs`，并通过 fresh database 与历史升级测试。

## Tauri 前后端契约

修改 Rust command 时，必须在同一个 PR 中检查：

1. `src-tauri/src/lib.rs` 中的 command 注册。
2. Rust 输入、输出结构和 serde 字段名。
3. 前端 `invoke` 的 command 名、参数包装和返回类型。
4. 对应 repository/service 的契约测试。

## 合并门禁

提交 PR 前运行：

```powershell
pnpm typecheck
pnpm lint
pnpm test:run
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

涉及界面交互时，使用项目已经安装的无头 Chromium 验收。测试结束后关闭验收进程，只保留需要的 1420 端口 Tauri 窗口。

CI 必须全部通过才能合并。若主干已有失败，先单独修复基线，不能在功能 PR 中忽略或扩大失败范围。
