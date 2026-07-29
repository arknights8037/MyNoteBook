# 后续开发路线图

本文只记录截至 2026-07-28 仍未完成的工作。已经完成的架构事实分别维护在 [系统架构](architecture.md)、[Agent Runtime](agent-runtime.md)、[认知系统集成](cognitive-system-integration.md)、[工作区视图](workspace-views.md) 和 [MCP Client](mcp-client.md) 中；历史完成过程与当时的测试数字以 Git 记录为准，不再复制到路线图。

## 当前基线

以下能力已经进入主干，不再作为待办重复列出：

- 受控 Agent Runtime、ExecutionPolicy、Context Bundle v2、工具审计、取消和 Patch/Diff/确认/撤销链路。
- Research、Review、Learning 三种认知模式及其结构化输出、Session 和 Knowledge Candidate 审核流程。
- Slidev、UML、Table 结构化工作区视图，以及 Mind Map；结构化视图支持置顶和树形组织。
- stdio MCP Server 的本地项目目录、A2A 分支路由、请求修订、批准/拒绝和决策回执。
- 文档、知识、Work/View、治理、Outbox 与 Agent 审计的版本化 SQLite 迁移链。

“已实现”只表示代码和定向测试已经存在，不代表所有真实 Provider、安装包和长时间运行场景都完成验收。

## R0：真实环境与发布验收

### Research 与 Learning 真实链路 smoke

Review 已完成真实 DeepSeek/Tauri smoke；Research 与 Learning 仍需要在真实桌面运行中分别覆盖：

- 真实 Provider 的工具循环、结构化 contract 和终态保存。
- Research 候选的来源跳转、revision 复验、接受与拒绝。
- Learning 的 `waiting_user`、跨运行恢复、回答后继续和候选入库。
- 取消、超时、Provider 错误和应用重启后的可诊断状态。

验收结果应记录场景和失败原因，不再把某次测试总数写进长期文档。

### Windows 安装与升级

- 验证全新安装、已有数据目录升级和自定义数据目录迁移。
- 验证数据库、WAL/SHM、附件、Skills、MCP 配置和数据目录内 Artifact 的一致性。
- 验证升级失败自动恢复、旧版本回退边界和卸载后用户数据策略。

## R1：Agent 契约收敛

### 单一工具契约目录

当前工具名称、描述、风险和标签已经集中到 `AgentToolRegistry`，但前端 Zod 输入 schema、Provider schema、Rust 原生命令参数和 UI 展示元数据仍有重复定义。下一步应：

- 为每个工具建立可生成或可快照比对的统一契约。
- 在 CI 中比较前端、Rust 和 MCP 暴露的名称、必填字段、风险与只读标记。
- 让工具结果展示优先消费统一的 typed presentation，而不是继续增加字符串分支。

### 写入协议减法

非认知运行仍同时支持旧的 `commands` 与 `patches` 终态协议，以及工具驱动的 `submit_document_edits`。需要明确长期保留的最小协议，并为迁移期建立兼容边界，避免同一种修改存在多条行为略有不同的路径。

### 长运行诊断

运行级 lifecycle、run events、tool calls 和 timeline 已随消息持久化，但 UI 快照是有界数组，规范工具审计仍在独立表中。后续需要提供按 task/run 查询完整审计的诊断入口，使“读取了哪些块、是否复用了缓存、为何重试或停止”无需依赖当前消息卡片的截断视图。

## R2：结构化工作区的 Agent 能力

当前 Agent 可以列出和读取 Mind Map，但还没有面向 Slidev、UML、Table 的完整工具集，也不能受控地创建或修改这些视图。

优先顺序：

1. 为三类结构化视图提供只读目录和 canonical source 读取工具。
2. 定义带 revision、Diff 和确认的视图修改提案，不允许模型直接写表。
3. 增加“从文档生成视图”和“把视图结果回写为文档提案”的显式转换。
4. 对 Slidev `nbId`、UML 节点/边 ID、Table 行列 ID 建立稳定锚点和并发冲突测试。

## R3：自动化执行器

当前自动化功能保存任务定义、生成待运行队列并展示历史，但应用内没有后台模型调度器或执行 worker。下一阶段需要：

- 明确应用关闭、休眠、时区变化和错过触发时间时的行为。
- 为 interval/daily/manual 建立唯一领取、lease、重试和取消语义。
- 把一次自动化运行映射到现有 Agent/Work 审计，而不是建立第二套执行循环。
- 默认只产出可审阅结果；任何文档修改继续走 Patch 和确认边界。

## R4：Dashboard Composer 后续

[Dashboard Composer](dashboard-composer.md) 的 P0 已实现：信息面板使用 Grid Layout Plus、版本化 `workspace_views` 持久化，以及 `Automation Results` 与 `Agent Work Status` 两个只读组件。

剩余工作：

- 在 Tauri WebView2 中完成人工高 DPI、拖拽和键盘替代操作验收；
- 接入真实 Signal 数据后实现 RSS Briefing 与 Signal Inbox Widget；
- 为 Widget 增加来源时间、权限状态和 canonical 记录跳转；
- 保持 Dashboard 只消费查询和受控 command，不成为第二写入口。

## R5：采集与外部集成

更广泛的 Signal/消息连接、邮件 OAuth、日历和网页裁剪仍属于未来集成。标准 IMAP 邮箱读取已按[邮箱连接器与收件箱](email-inbox.md)完成首个只读版本；RSS 已按[RSS 连接器与收件箱](rss-inbox.md)完成手动条件同步与统一收件箱版本；钉钉已按[钉钉消息连接器与收件箱](dingtalk-inbox.md)完成企业机器人 Stream 只读接收版本。后续接入顺序应遵循：

1. 先以 MCP Resource 或受限只读工具读取。
2. 保存来源、时间、权限和内容哈希。
3. 让模型产出候选、摘要或任务，不直接写正式知识。
4. 需要副作用的外部动作必须逐次授权并保留审计。

页面归属遵循[工作区导航与信息架构](navigation-information-architecture.md)：连接配置进入“连接与扩展”，采集内容进入“收件箱”，跨来源摘要进入“信息面板”。

## 暂不进入近期范围

- 第二套 Agent Runtime 或第二套认知执行循环。
- 自动把模型输出提升为正式知识或直接写正文。
- 任意代码插件、任意 shell、未授权网络抓取。
- 云同步、多人实时协作、向量库或图数据库替换 SQLite。
- 超出当前本地项目分支与请求队列的自治多 Agent 编排、市场和计费体系。

## 路线图维护规则

- 只保留未完成事项；完成后迁移到对应专题文档的“当前能力”，并从本文件删除。
- 不保存易失真的测试通过数量、请求 ID 或临时调试记录。
- 每项能力必须同时说明事实源、写入边界、失败恢复和验收方式。
- 若代码与本文冲突，以代码、迁移和可重复的定向测试为核验依据，并立即修正文档。
