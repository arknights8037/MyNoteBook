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

## MyNoteBook MCP Server 与 Agent 通信

`src-tauri/src/bin/mynotebook-mcp.rs` 是独立 stdio Server。未配置 `MYNOTEBOOK_AGENT_CAPABILITY_TOKEN` 时，它以 SQLite `query_only` 模式公开当前有效 Rule、Decision、开放 TaskRun、指定 Context Bundle 和知识搜索。

插件与技能页面的 **MCP Server** 选项卡用于控制八个工具的对外暴露面。策略保存在资料目录的 `mcp-server-exposure.json`；关闭的工具不会出现在 `tools/list`，按名称直接调用也会失败。设置由新启动的 Server 进程读取，因此修改后需要重启 Server 或让客户端重连。若配置文件不存在，所有工具保持暴露以兼容既有安装；项目目录和写入类工具仍要求 `MYNOTEBOOK_AGENT_CAPABILITY_TOKEN`。

配置 capability token 后，Server 额外开放受控 Agent 通信工具：

- `submit_agent_request`：把通用任务说明加入本地队列，不运行第二套模型循环，也不批准或应用 Patch。
- `submit_cognitive_request`：通过 `mode=research|review|learning` 把 C2-C4 认知任务加入同一队列。桌面端将模式绑定到已有 Cognitive Runtime；Learning 后续调用会恢复当前会话中的等待状态。
- `list_agent_projects`：返回项目、资料根分组、既有对话和已登记的 A2A 分支，供外部 Agent 在创建任务前发现正确归属。
- `create_agent_branch`：在指定项目下创建稳定分支，可通过 `parent_conversation_id` 关联既有对话或分支。
- `get_agent_request`：查询请求状态、AgentTask 和候选 Patch，属于只读操作。
- `decide_agent_request`：在请求已经进入 `awaiting_review` 后提交版本化审批回复并批准或拒绝；回复会绑定当前 `taskId` 与 `result.summary`，批准后由桌面应用通过既有确认与 Rust transaction 应用。
- `revise_agent_request`：对当前待审阅任务提交反馈并重新排队，继续沿用原项目和分支路由。

`mynotebook-agent` 是对应的 stdio MCP 客户端，可执行 `projects`、`branch`、`submit`、`research`、`review`、`learning`、`get`、`revise`、`approve` 和 `reject`。数据库 URL 可由 `--database-url` 或 `MYNOTEBOOK_DATABASE_URL` 提供；能力令牌只从 `MYNOTEBOOK_AGENT_CAPABILITY_TOKEN` 读取，避免出现在命令行参数中。该接口用于启动后的本地受控集成与验收，不允许调用方用它绕过 ExecutionPolicy、Patch/Diff、revision 校验或确认记录。

推荐的 A2A 路由顺序：先用 `projects` 读取项目目录，再用 `branch --project-id <id> --title <title>` 创建协作分支，最后在 `submit` 或认知模式命令中同时传入 `--project-id` 与 `--branch-id`。同一分支上的后续请求会复用同一条桌面对话及其资料根目录；仅传 `--project-id` 时会在指定项目下创建独立任务，不传路由参数时保持旧版未分组行为。

```powershell
mynotebook-agent projects --database-url $env:MYNOTEBOOK_DATABASE_URL
mynotebook-agent branch --database-url $env:MYNOTEBOOK_DATABASE_URL `
  --project-id project-1 --title "知识库同步"
mynotebook-agent submit --database-url $env:MYNOTEBOOK_DATABASE_URL `
  --project-id project-1 --branch-id branch-project-1-... --prompt "对比并更新本地规范"
```

`get_agent_request` 还返回请求的 `mode`、`route`，以及 Runtime 写入的版本化 `result` 信封：`version`、`outcome`、`summary`、`patchCount` 和 `targetDocumentIds`。`route` 包含 `projectId`、`branchId`、`branchTitle` 和 `parentConversationId`。认知任务额外返回 `result.cognitive`，包含规范化模式、结构化输出，以及 Learning 的最新会话状态。这是 Agent 向调用方回传执行汇总的标准通道；调用方不需要通过数据库、界面或重新解析对话消息猜测 Agent 做了什么。进入 `awaiting_review` 时信封与 Patch 同时持久化，批准或拒绝后继续保留。

审批调用写入独立的 `decision` v1 信封：`action`、`reply`、`requestId`、`taskId`、`resultVersion`、`resultSummary` 和 `decidedAt`。桌面端只消费与当前待确认 `taskId` 精确匹配的决定；其他实例不能把不属于自己的审批误标完成。CLI 的 `approve` / `reject` 可通过 `--reply` 提交审批回复，并可通过 `--summary` 要求当前 summary 精确匹配后再决定。

命令行客户端提供与 MCP 工具对应的快捷命令：`mynotebook-agent research|review|learning --prompt <text>`。这些命令只提交请求；使用 `get` 轮询结果。

通信请求生成的修改在进入 `awaiting_review` 前必须通过 Runtime 批级约束：一次提案可以包含多个已读取文档，但每个文档只分组一次，且该文档内的 edit targets 必须互不重叠。`get_agent_request` 只暴露已编译并通过约束的内部 Patch；`decide_agent_request` 不承担修复或排序歧义 Patch 的职责。批准多文档提案时，Rust 在同一个 SQLite transaction 中校验并写入全部目标，任一失败都会回滚整批。

## 委托完成封装

CLI Delegation envelope v2 会携带真实 Context Bundle，并推荐调用方只回传一个 `delegated-completion-v1`：

```json
{
  "version": 2,
  "delegationId": "delegation-1",
  "idempotencyKey": "task-final-v1",
  "completion": {
    "version": 1,
    "artifacts": [],
    "evidence": [],
    "changeSet": null,
    "result": {
      "type": "result",
      "entityId": "result-1",
      "output": { "summary": "已完成" }
    }
  }
}
```

Adapter 会按 Artifact → Evidence → ChangeSet → Result 展开为现有治理操作，并为每一项派生稳定 idempotency key。Result 始终最后提交；中途失败可安全重试，不需要第三方分别编排多个底层调用。该封装不复制 Rust 提交逻辑，也不允许直接写 canonical 文档。
