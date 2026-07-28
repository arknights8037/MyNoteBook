## 变更说明

<!-- 说明问题、解决方式和明确不在本次范围内的内容。 -->

## 影响模块

- [ ] 文档 / 编辑器
- [ ] Workspace / 视图
- [ ] Agent / AI / Cognition
- [ ] Integration / MCP / Skills
- [ ] Rust / 数据库 / 存储
- [ ] 公共 UI / 样式 / 构建配置

## 验证

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test:run`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] 涉及界面时，已使用项目内置无头 Chromium 验收

## 合并风险

- [ ] 没有修改已发布的 migration
- [ ] 新 migration 编号已与其他开发分支协调
- [ ] Tauri command 名称、参数和前端调用已同步
- [ ] 锁文件变更来自本次依赖调整
- [ ] 没有提交无关截图、日志或生成文件
