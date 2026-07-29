# MyNoteBook — AI 桌面工作中枢

> 让所有工作，都能从上一次结束的地方继续。

MyNoteBook 是一款面向知识工作者的、本地优先的 **AI 桌面工作中枢**（AI Workspace Hub）。它以 **Agent Work** 为任务入口，以文档、知识和项目作业区作为上下文，以受控的 **Work** 流程保存执行、验证和审批结果。

在这里，AI Agent 不是悬浮在资料之外的聊天框，而是进入具体项目：读取允许范围内的文档和知识，调用内置工具、Skills 或 MCP，执行 Research、Review、Learning 和编辑任务，再把结果交回文档、知识控制、Work 记录和审计系统。

它不是“带 AI 的知识库”，也不是承诺替用户自动完成一切的 Agent。它的核心主张是：

> 不是替你工作，而是让你的工作始终处于被理解、被组织、可继续的状态。

## 为什么需要工作中枢

知识工作真正困难的地方，通常不是缺少某个功能，而是工作长期处于断裂状态：

- 信息散落在网页、聊天、文档、会议和不同软件中。
- 任务和资料彼此分离，执行时需要反复寻找上下文。
- AI 可以生成内容，却不了解项目状态、历史决策和未完成事项。
- 工作完成后，过程没有沉淀，下次仍然从头开始。
- 同一份内容需要反复改造成汇报、文档、表格和幻灯片。
- 传统自动化追求“无人操作”，却难以处理复杂、模糊和高风险任务。

MyNoteBook 希望把这些断裂连接成一条可以暂停、恢复、协作和积累的工作链路。

## 工作循环

产品围绕一个持续循环组织能力：

**收集 → 理解 → 组织 → 委派 → 表达 → 沉淀**

| 阶段            | 当前产品中的入口                                                      | 形成的结果                                 |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| 收集 Collect    | 文档导入、知识资产、AI 对话导入、当前页面与 MCP Resources             | 带来源的项目资料和 Agent 上下文            |
| 理解 Understand | Agent Work 中的 Ask、Research、Review 和文档检索                      | 回答、研究结论、证据、冲突与审查问题       |
| 组织 Organize   | 项目作业区、文档与视图、知识控制                                      | 文档、知识对象、任务、决策和智能视图       |
| 委派 Delegate   | Agent 模式、内置工具、Skills、MCP、CLI Agent 和受控外部委派           | 可观察的运行过程、工具结果和待验证交付物   |
| 表达 Present    | 文档、思维导图、表格、UML/流程图和 Slidev 幻灯片                      | 面向不同对象的工作空间视图                 |
| 沉淀 Retain     | Research Candidate、Patch 确认、TaskRun、Artifact/Evidence 与审计记录 | 被确认的知识、正式修改、验证结果和历史轨迹 |

## 它不是什么

### 不是另一个聊天机器人

Agent Work 按项目保存作业区和对话。一次运行会冻结实际使用的文档、知识、Provider、模式和权限；重启后仍可从项目、会话和任务继续，而不是只留下一段孤立聊天。

### 不是另一个自动化平台

系统不承诺把复杂工作全部交给 AI。人负责目标、判断和责任；Agent 负责搜集、整理、执行和跟进。当前“自动化任务”提供任务定义、定时指针和运行队列，但不在后台无人值守地唤醒模型。

### 不是另一个文档编辑器

文档只是工作信息的一种视图。同一套内容还可以表现为任务、表格、图表、思维导图或幻灯片。

### 不是静态知识库

知识会随着任务执行、外部信息和用户决策持续演进，并保留来源、版本和审批状态。

## 核心产品原则

### 工作可以暂停，上下文不能丢失

AI 不一定能一句话完成复杂任务，但用户不应该每次都重新解释项目。任务可以暂停，下一次应当从正确的位置继续。

### 信息要进入工作流，而不是收藏夹

收藏只是把信息留给未来；工作中枢需要识别信息属于哪里、意味着什么，以及下一步应该做什么。

### 单一事实源，多种表达方式

内容只有一份，表达可以有很多种。MyNoteBook 将项目知识“编译”为适合自己、团队、客户、管理者或 Agent 使用的不同视图。

### Agent 执行会形成长期积累

Research 结果可以形成待确认的知识候选，Review 问题可以转入独立 Edit，Learning Session 可以等待下一次回答，Agent Patch 可以进入确认和撤销流程；任务、工具、验证与审批同时进入 Work 和审计记录。

### 自动化执行，不自动化责任

高风险动作需要确认，知识更新具有来源和版本，Agent 修改以提案呈现，关键过程可查看、可追溯、可撤销。

### 桌面是工作控制台

浏览器标签页是工作发生的地方，桌面中枢是工作被组织的地方。本地数据、文件、模型、Agent、MCP 和外部服务在同一个控制台中被协调。

## 当前产品结构

| 工作区         | 当前职责                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent Work** | 管理 Agent 项目、文档分组作业区和持久化对话；运行 Ask、Edit、Agent、Plan、Research、Review、Learning 等任务，并展示 Step、Tool、Observation、授权等待和 Summary |
| **文档与视图** | 编辑结构化文档，管理文档树、思维导图、表格、UML/流程图和 Slidev 幻灯片；为 Agent 提供稳定 Block、选区和 revision                                                |
| **知识控制**   | 管理知识资产、规则、决策、证据、Research Candidate、智能视图和 Work 对象；正式知识保留来源、版本和验证状态                                                      |
| **插件技能**   | 管理 Skills、MCP Server、Tools、Resources 和对外 MCP 暴露；未信任或可写工具需要授权                                                                             |
| **自动化任务** | 创建绑定页面的手动、间隔或每日任务，维护调度指针、运行队列和状态；当前不包含后台模型执行器                                                                      |
| **审计记录**   | 汇总 Agent Task、Tool Call、Patch、Automation Run、TaskRun、Verification、ChangeSet、Approval、Delegation 和 View 刷新                                          |

## Agent Work 与 Work 闭环

Agent Work 是用户看见和控制任务的工作台，Work 是任务结果进入系统后的结构化闭环：

```text
项目 + 文档作业区 + 持久化对话
  -> Ask / Edit / Agent / Slash Command
  -> Context Bundle + ExecutionPolicy
  -> 内置工具 / Skills / MCP / CLI Agent
  -> 回答、Research、Review、Learning、Artifact 或 Patch
  -> Result Verification / 用户确认
  -> Knowledge、ChangeSet、Approval、文档事务与审计记录
```

- **Ask**：基于当前项目上下文生成回答，不产生写入提案。
- **Edit**：生成结构化 Patch，经本地校验和 Diff 确认后才能写入。
- **Agent**：运行真实的模型—工具—Observation 循环，可暂停、取消或等待授权。
- **Research**：输出 Claim、Evidence、Assumption、Conflict 和 Question，并将条目保存为待确认候选。
- **Review**：以只读方式发现来源、逻辑、冲突和范围问题；只有用户选择处理某一项时才进入新的 Edit。
- **Learning**：保存可恢复的多轮学习状态和用户 Attempt，不自动把临时理解写成正式知识。
- **Work**：用 TaskDefinition/TaskRun、Artifact/Evidence、Result Verification、ChangeSet/Approval 保存“做了什么、依据是什么、是否通过、是否允许写回”。

## 技术基础

- Vue 3 + Tiptap 的结构化编辑器与稳定 Block ID。
- Tauri/Rust + SQLite 的本地优先存储、全文检索、迁移和备份恢复。
- 带 Context Bundle、ExecutionPolicy、Tool Loop、取消和审计的 Agent Runtime。
- revision 冲突保护、批量 Patch transaction 和安全撤销。
- 版本化 Knowledge、Work、View、Governance 和 Cognitive 协议。

## 可组合情报与工作面板（演进方向）

MyNoteBook 计划提供一个受控的 Dashboard Composer。用户可以从内置 Vue Widget 库中选择卡片，自行拖拽、缩放和配置页面，把最重要的外部信号、工作状态和决策入口组合成自己的工作台。

首批面板组件计划包括：

- **RSS Briefing**：订阅更新、增量摘要、主题聚类、来源异常和“自上次阅读以来”的变化。
- **Signal Inbox**：汇总 RSS、IM、MCP 与外部系统信号，并将信息关联到项目。
- **Automation Results**：自动化任务的 queued、running、completed、failed 状态，输出摘要和下次运行时间。
- **Agent Work Status**：正在运行、等待用户、等待外部结果、失败和已完成的 Agent 任务。
- **Decision Queue**：集中处理 Research Candidate、Review Issue、ChangeSet、Approval 和待验证结果。
- **Ask Agent**：针对当前面板、项目或用户选中的卡片进行咨询，并将结论转为 Research、Decision 或 Task。

面板只保存 Widget 类型、查询配置和布局 JSON，业务数据仍来自 Automation、Work、Knowledge、Agent、RSS 和 Audit。用户可以自由排版，但不能通过布局绕过正式状态转换或写入边界。

第一阶段只加载随应用编译并注册的 Vue Widget，不执行用户提供的任意 `.vue`、JavaScript、HTML 或 SQL。未来 Plugin Widget 也必须声明数据与操作权限，并经过安装、启用和版本校验。

这个方向提供类似 Notion 的自由组合体验，但产品重点不是复制通用数据库，而是让创作者和创业者自行组织：

> 外部发生了什么、哪些工作正在推进、什么需要我判断，以及下一步可以交给哪个 Agent。

邮件、会议、更多外部应用接入，以及更完整的“内容编译”和长期后台协调能力属于演进方向，不在 README 中伪装成已经完成的功能。

## 产品愿景

MyNoteBook 的目标不是增加更多孤立工具，而是建立一个长期存在的工作状态层：

- 一个项目越做越轻，而不是越做越乱。
- 今天没有完成的工作，明天可以从正确的位置继续。
- 同一套知识可以服务不同对象和表达形式。
- 人始终掌握目标、判断和最终写入权。
- 每一次工作都会让系统积累更多可复用的上下文。

完整定位、品牌叙事和对外表达规范见 [产品定位与愿景](docs/product-positioning.md)。

## 技术与维护文档

- [产品定位与愿景](docs/product-positioning.md)：产品类别、工作循环、差异化和品牌表达。
- [可组合情报与工作看板](docs/dashboard-composer.md)：可控组件排版、Widget 架构、RSS/IM/自动化卡片与分阶段落地方案。
- [当前架构与模块边界](docs/architecture.md)：代码所有权、领域边界、真实能力和已知偏差。
- [Agent Runtime 与工具协议](docs/agent-runtime.md)：运行循环、上下文、权限、工具、审计和 Patch 确认。
- [认知系统集成设计](docs/cognitive-system-integration.md)：Cognitive Mode、知识控制模板和 Knowledge Candidate。
- [后续开发路线图](docs/roadmap.md)：尚未完成的稳定性门禁与产品里程碑。
- [数据库持久化与运维](docs/database.md)：Schema 所有权、迁移、数据目录和备份恢复。
- [自动化任务与审计](docs/automations.md)：自动化定义、运行队列及当前执行边界。
- [MCP Client 与外部协议](docs/mcp-client.md)：Tools、Resources、只读 MCP Server 和 Delegation 边界。
- [钉钉消息连接器与收件箱](docs/dingtalk-inbox.md)：Stream 接收范围、在线语义、凭据保护和消息去重。
- [邮箱连接器与收件箱](docs/email-inbox.md)：IMAP 只读同步、来源游标与网易 ID 兼容。
- [RSS 连接器与收件箱](docs/rss-inbox.md)：条件拉取、正文提取和统一时间线。
- [工作空间视图](docs/workspace-views.md)：文档、思维导图、幻灯片、UML/流程图和表格。

维护文档只描述当前事实或明确标记的未来设计。历史实施过程通过 Git 追溯。

## 开发

```bash
pnpm install
pnpm tauri dev
```

数据库迁移只由 Rust/SQLx 在应用启动时执行。不要修改已发布的迁移文件；Schema 变化必须新增 migration。

多人开发、模块所有权、迁移协调和合并门禁见 [协作开发规范](CONTRIBUTING.md)。
