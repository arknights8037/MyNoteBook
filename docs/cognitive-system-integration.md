# 认知系统集成设计

> 实现状态（2026-07-16）：C1 最小认知内核、C2 Research、C3 Review 和 C4 Learning 功能已落地。Learning 使用 `waiting_user` Cognitive Session 跨 run 保存 Attempt、当前问题、提示层级与理解状态；首次不直接给答案，状态变化必须有用户尝试 evidence，候选理解不写正式知识。真实 Provider/Tauri 联合 smoke 仍待执行。

## 1. 目标

认知系统是在现有 Agent Runtime 上增加的策略与知识控制层，不是第二套 Agent、Tool Registry 或会话应用。它使统一 Agent 能根据 Learning、Research、Review 等认知任务改变交互方式、上下文、工具权限和输出结构，并把模型临时输出与候选知识、正式知识明确分开。

目标数据流：

```text
用户输入 / Slash Command / 编辑器入口
  -> 选择 Cognitive Mode
  -> 加载 Knowledge Control Template
  -> 编译 CognitiveRunSpec
  -> 现有 Context Bundle + ExecutionPolicy
  -> 现有 Agent Runtime
  -> 现有 Tools / MCP / Skills
  -> AgentOutputContract 结构化校验
  -> Cognitive Result + Knowledge Candidates
  -> 用户确认
  -> 现有 Knowledge/Approval/Audit 边界
```

## 2. 当前能力映射

| 愿景能力       | 现有实现                                               | 集成决定                                            |
| -------------- | ------------------------------------------------------ | --------------------------------------------------- |
| Agent 调用循环 | AI SDK `ToolLoopAgent`                                 | 直接复用，不创建新 Runtime                          |
| 工具权限       | Tool Registry + Tags + `ExecutionPolicy.allowedTools`  | Tags 已在运行前编译，Runtime 仍检查工具名           |
| MCP            | Tools/Resources Client、只读 Server                    | 直接复用相同信任和授权协议                          |
| Skills         | Skill 摘要注入、按需读取                               | 通过 binding 关联 Mode，不把 Mode 变成 Skill 子类型 |
| Slash Command  | plan/create/interactive/research/review 等 intent      | 命令只选择认知任务，不承载业务逻辑                  |
| 上下文         | Context Bundle、document/block/revision、Rule/Decision | 增加认知 context policy 和 session state            |
| 结构化输出     | command/Patch + 可插拔 `AgentOutputContract<T>`        | 同一 Runtime 按运行注入 contract                    |
| 知识生命周期   | 扩展 Knowledge Object + candidate/approved/rejected    | 复用现有模型，不建平行候选仓库                      |
| 来源与验证     | 多 SourceRef、Knowledge Validation、Evidence/Verifier  | C2/C3 复用现有来源与验证表                          |
| 写入治理       | Patch/Diff、Approval、revision、Audit                  | 候选接受复用版本检查与审计；不自动改正文            |

## 3. 核心扩展契约

第一版只实现代码内、版本化的 Mode/Template Registry，不提供用户编辑规则或自然语言规则引擎。

```ts
type CognitiveModeId = 'learning' | 'research' | 'review'

interface CognitiveModeDefinition {
  id: CognitiveModeId
  name: string
  description: string
  interactionPolicy: CognitiveInteractionPolicy
  contextPolicy: CognitiveContextPolicy
  outputContractId: string
  allowedToolTags: string[]
  deniedToolTags: string[]
  defaultSkillIds: string[]
  defaultTemplateId: string | null
  systemInstructionFragments: string[]
  version: number
  enabled: boolean
}

interface KnowledgeControlTemplate {
  id: string
  name: string
  applicableModes: CognitiveModeId[]
  extractionRules: KnowledgeExtractionRule[]
  validationRules: KnowledgeValidationRule[]
  conflictRules: KnowledgeConflictRule[]
  approvalPolicy: KnowledgeApprovalPolicy
  promptFragments: string[]
  version: number
  enabled: boolean
}

interface CognitiveRunSpec {
  modeId: CognitiveModeId
  modeVersion: number
  templateId: string | null
  templateVersion: number | null
  skillIds: string[]
  interactionPolicy: CognitiveInteractionPolicy
  contextPolicy: CognitiveContextPolicy
  executionPolicy: ExecutionPolicy
  outputContractId: string
  promptFragments: string[]
}

interface AgentOutputContract<T> {
  id: string
  version: number
  jsonSchema: Record<string, unknown>
  systemInstruction: string
  validate(value: unknown): T
}
```

`CognitiveRunSpec` 是认知层与现有 Runtime 的唯一边界。Runtime 不理解 Learning/Research/Review 业务，只执行编译后的 Prompt、ExecutionPolicy 和 Output Contract。

## 4. 编译与权限优先级

Prompt 编译顺序固定为：

```text
基础 Agent 安全策略
+ 当前 Skill 指令
+ Cognitive Mode 策略
+ Knowledge Control Template 规则
+ 当前任务
+ Context Bundle 内容
+ Output Contract 指令
```

权限采用只收紧、不放大的合并规则：

1. 基础 Runtime 安全策略拥有最高优先级。
2. Mode/Template/Skill 都不能开放基础策略禁止的写入或工具。
3. `deniedToolTags` 优先于 `allowedToolTags`。
4. Tool Tags 在运行前解析成稳定工具名并写入 ExecutionPolicy。
5. MCP 工具即使标签允许，仍必须通过本地信任、`readOnlyHint` 和逐次授权检查。
6. Output Contract 只控制返回结构，不能执行写入。

第一版 tags 至少覆盖：

```text
document.read
document.propose_write
knowledge.read
knowledge.propose_write
knowledge.validate
system.inspect
external.read
external.may_write
cognition.interact
```

## 5. Cognitive Session

普通聊天消息不承担认知状态写真源。新增持久化 `CognitiveSession`，一个 session 可以关联多次 Agent run：

```ts
interface CognitiveSession {
  id: string
  conversationId: string
  modeId: CognitiveModeId
  modeVersion: number
  templateId: string | null
  templateVersion: number | null
  skillIds: string[]
  targetDocumentIds: string[]
  targetBlockIds: string[]
  state: Record<string, unknown>
  status: 'active' | 'waiting_user' | 'completed' | 'cancelled'
  createdAt: number
  updatedAt: number
}
```

Session 与 conversation、AgentTask/TaskRun 通过 ID 关联，但不替换现有消息或 Work 模型。Research/Review 通常单次完成；Learning 使用 `waiting_user` 保存用户尝试、当前问题和理解状态后恢复。

## 6. Knowledge Candidate 映射

Knowledge Candidate 复用 `knowledge_objects`，不新增平行 staging 仓库。Migration `0014` 已完成以下扩展：

- `object_type`：在现有 decision/rule/goal/task/evidence/change_set 基础上增加 fact、claim、inference、assumption、concept、question、limitation。
- `status`：增加 `rejected`；`candidate` 表示待确认，`approved` 表示用户已接受，只有 Rule/Decision 等明确生效对象才进入 `active`。
- 一等字段：正文、结构化数据、generated run、cognitive mode、template ID/version。
- `knowledge_object_sources`：一对多 document/block/revision/quote/startOffset/endOffset。
- `knowledge_validations`：规则、verdict、severity、说明、验证来源和时间。

“修改后接受”先以 expected version 更新 candidate，仍保持 `candidate`，再执行接受状态迁移；不增加容易混淆的永久 `modified` 状态。拒绝保存为 `rejected` 以保留审计，不删除候选。

来源 revision 与当前文档不一致时，读取层将候选标记为需要重新验证。未重新验证的候选不能直接接受为 approved；第一版不需要后台扫描全部对象。

候选接受是明确的用户审批动作，由 Knowledge Service/Repository 以 optimistic version 和审计记录提交。它不创建文档 ChangeSet，也不自动修改原文；需要改文档时仍走既有 Agent Patch/Diff。

## 7. Research 首个纵向闭环

现有 `/research` 从自由文本 intent 升级为结构化 Research Mode：

```text
选择文档或选区
  -> /research
  -> research mode + research-conclusion template
  -> document.read / knowledge.read / external.read
  -> Claim / Evidence / Assumption / Inference / Limitation / Conflict
  -> SourceRef 与 Validation
  -> Agent 消息内结构化结果面板
  -> 接受 / 编辑后接受 / 拒绝 / 保留
  -> approved Knowledge Object
```

Research 默认只读：`allowWriteProposals=false`，不能修改文档，也不能把高 confidence 当作审批。输出至少回答研究问题、主张、直接证据、隐含假设、局限、冲突和未解决问题。

来源必须尽量落到 block/revision。无法提供来源的项目可以作为 question 或未验证 claim 展示，但必须暴露不确定性，不能伪装成 fact/evidence。

## 8. Review 与 Learning 扩展

Review 在 Research 稳定后复用相同的来源、Validation、Conflict 和候选确认组件，增加 issue type、severity、原始位置、说明和建议动作。Review 默认只读；建议修改必须显式转成既有 Patch 提案。

Learning 最后实现，因为它需要多轮 session 状态机：

```text
要求用户先解释
  -> 保存 LearningAttempt
  -> 分析正确点/遗漏/误解
  -> 追问或逐级提示
  -> waiting_user
  -> 用户再次尝试
  -> 更新理解状态
```

Learning 不默认直接给完整答案，不按对话次数判定掌握，不自动生成正式知识，也不能绕过用户确认。

## 9. UI 集成

- 模式入口复用现有 Agent composer、Slash Menu、选区工具栏和编辑器上下文，不建立独立应用区。
- Agent loop 继续显示通用工具运行；Cognitive Result 作为同一 assistant 消息中的结构化结果块显示。
- Candidate 卡片支持来源跳转、验证详情、接受、编辑后接受、拒绝和保留。
- Knowledge Control 页面负责跨会话查看候选、正式知识和验证状态，不复制聊天主流程。
- 第一版不实现知识图谱画布、模板编辑器或复杂规则 UI。

## 10. 禁止的平行实现

- 不创建第二套模型循环、Tool Registry、MCP Client 或 Skill Registry。
- 不把认知状态仅存入 Prompt 或整段聊天历史。
- 不用字符串分支分别解析三个模式；所有结构化结果必须经过 Output Contract。
- 不让 Mode/Skill/Template 绕过 ExecutionPolicy。
- 不让模型输出、Candidate、View 或 Artifact 自动成为正式知识。
- 不因实现认知系统而一次性替换现有 AgentTask、TaskRun 或聊天模型。

实施顺序和验收门禁见 [后续开发路线图](roadmap.md)。
