# MCP Client

MyNoteBook 可以作为 MCP Client 连接用户显式导入并启用的外部服务。当前支持：

- 本地 `stdio` 服务：应用按配置启动子进程，通过标准输入输出完成 MCP 握手和调用。
- 远程 Streamable HTTP 服务：通过 `http://` 或 `https://` MCP endpoint 建立会话。
- 工具发现：管理页可测试连接并显示服务提供的工具。
- Resource 发现与读取：Integration Gateway 提供 `resources/list` 和 `resources/read`，保留 30 秒超时与有界会话。
- Agent 动态工具：每次 Agent 运行开始时读取所有已启用服务的工具 schema，并注册为原生 function calling 工具。
- 调用保护：服务默认不可信。只有用户在本地明确标记 Server 为可信，并且工具声明 `readOnlyHint: true` 时才可直接调用；其他工具每次调用前都必须由授权人确认。

## 导入格式

在“插件与技能 -> 外部 MCP 服务”中选择 JSON 文件。推荐使用常见的 `mcpServers` 格式：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\Notes"],
      "env": {
        "EXAMPLE_TOKEN": "local-secret"
      },
      "cwd": "D:\\Notes",
      "disabled": true
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer local-secret"
      },
      "enabled": false
    }
  }
}
```

也支持使用 `servers` 作为集合字段，或直接以服务名为根对象的配置。每个服务必须提供 `command` 或 `url`：

- 存在 `command` 时识别为 `stdio`。
- 不存在 `command` 且存在 `url` 时识别为 Streamable HTTP。
- `enabled` 默认是 `true`；`disabled: true` 会覆盖默认值。建议首次导入时保持停用，先在管理页测试连接和检查工具，再手动启用。

重复导入相同服务 ID 会更新原配置，其他已导入服务保持不变。规范化后的配置保存在应用数据目录的 `mcp-servers.json`。

## 安全边界

- 导入 `stdio` 配置等同于授权应用启动其中指定的外部程序。只导入可信配置。
- MCP 工具不能绕过 MyNoteBook 的文档 Patch/Diff 确认协议。
- MCP annotations 只是风险参考，不能建立本地信任。导入或重新导入配置不会自动设置 `trusted`；信任必须在管理页单独确认，也可以随时撤销。
- MCP 返回内容会作为外部、不可信工具结果交给模型，不会直接写入文档。
- 当前版本会把 `env` 和 `headers` 保存在本机 `mcp-servers.json`。如果配置包含长期密钥，应限制数据目录访问；将 MCP 凭据迁移到系统密钥库列为后续安全增强。
- 当前连接采用“发现/调用时建立，完成后关闭”的有界会话，单次初始化、发现或调用默认最多等待 30 秒。

## 当前限制

- MCP Client 已接入 Tools 与 Resources；Prompts、Roots、Sampling 和 OAuth 尚未开放。
- 不支持旧版 HTTP+SSE transport，只支持当前 Streamable HTTP。
- 不保持跨 Agent 任务的长连接；有状态 MCP 服务应自行持久化状态。
- 某个已启用服务连接失败时，本次 Agent 运行不会加载 MCP 工具，但知识库内置工具仍可继续使用。

## MyNoteBook 只读 MCP Server

`src-tauri/src/bin/mynotebook-mcp.rs` 是独立 stdio Server，以 SQLite `query_only` 模式公开当前有效 Rule、Decision、开放 TaskRun 和指定 Context Bundle。它不提供写工具；Artifact/Evidence/Result/ChangeSet 必须通过带 capability token 的 Delegation Gateway 提交。
