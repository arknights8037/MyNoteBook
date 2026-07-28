# 工作空间视图

## 当前模型

空间是内容容器，视图不是与空间并列的第二套目录。文档、思维导图、幻灯片、UML/流程图和表格都显示在同一棵空间树中，并通过 `parentId` 与 `sortOrder` 参与父子层级和排序。

所有创建入口共用同一个类型选择器：侧栏“新建视图”、空间标题栏的 `+`、文件夹或页面的 `+`，以及右键菜单中的“新建内容”。从树节点发起创建时，新内容会继承该节点作为父级。结构化视图和思维导图支持打开、重命名、自动保存、拖入文件夹和删除。

这套设计不尝试把一份数据实时投影成所有展示形式。每种内容独立编辑、独立持久化；未来的跨类型转换应由 Agent 在读取来源后生成目标内容，并继续经过本地校验和用户确认，当前尚未暴露这组工具。

## 内容类型

### 文档

- 使用 Tiptap 块编辑器和既有 document aggregate。
- 表格块、数学块、多媒体和 Agent Patch 继续以文档 block 为边界。
- 文档可以作为目录树父节点承载其他内容。

### 思维导图

- 使用 MindElixir 作为人类编辑器，canonical 数据为版本化 `MindMapContent`，不把第三方 DOM 当作持久化格式。
- 节点保存稳定 ID、父级、顺序、文本、备注、折叠状态、根分支方向、来源引用、领域 metadata 和样式；跨节点关系单独保存在 `links`。
- 左右主分支及其后代显式继承 `left` / `right` 语义。同级节点和子节点创建时沿当前根分支继承方向。
- 节点编辑期间不提交 `beginEdit` 事件，也不应用外部 payload 刷新；编辑完成后才产生内容变更和自动保存。画布拖拽、节点选择和非模态右键菜单使用独立事件边界。
- 开发面板提供 canonical JSON 和 Agent 指向性文本；当前 Agent Runtime 已提供思维导图列表与子树读取工具。

### 幻灯片

- canonical 数据改为单文件 Slidev Markdown；每页使用 `nbId` frontmatter 保持稳定身份，文本框位置使用 Slidev 原生 `dragPos` 与 `<v-drag>` 表达，不再维护平行的模板/slot JSON。
- 人类编辑器提供页面新增、复制、删除、重排，标题与正文双击编辑，浮动文本框新增、编辑、拖动与缩放，演讲者备注、源码模式和本地演示模式。默认页面使用 Slidev `default` layout；高级 Slidev 内容可保留并转入源码模式编辑。
- 旧的页面/模板/slot payload 在 repository 读取时自动投影为 Slidev Markdown，首次保存后按新格式持久化。导出格式为 `.md`。
- 当前已接入 `@slidev/parser` 和 Slidev CLI 依赖；第一阶段完成人类编辑器，Agent 创建、修改和跨内容转换工具仍属于下一阶段。

### UML / 流程图

- 第一期只接受受限 Mermaid `flowchart`，Mermaid source 是 canonical payload。
- 预览从 source 渲染；语义节点列表允许按节点 ID 修改标签并写回 source。
- 当前支持 `.mmd` 导出，尚未接入 Agent 创建和修改工具。

### 表格

- canonical payload 复用文档表格的二维 rows 与 `TableField` 字段定义。
- 独立表格视图使用轻量 Vue 编辑器，避免 VTable 在视图切换和卸载阶段的编辑实例竞态；表头修改会同步字段名。
- 当前支持 CSV 导出，尚未接入 Agent 创建和修改工具。

## 持久化

- 思维导图使用 `mind_maps` 及 revision history，并通过 migration `0020`、`0022` 增加 aggregate 与树位置。
- 幻灯片、UML 和表格共用 `workspace_views` 及 revision history，并通过 migration `0021`、`0023` 增加 aggregate 与树位置；migration `0026` 增加 `pinned_at`，侧栏可持久化置顶结构化视图。
- 文档和思维导图保留各自专用 aggregate；`slides | uml | table` 共用 `StructuredWorkspaceView`，避免为了表面统一而破坏各类型语义。
- 当前置顶只属于 `workspace_views`；`mind_maps` 没有 `pinned_at`，文档也继续使用各自既有排序语义。
- UI 不显示每次自动保存产生的内部版本计数；version 只用于 optimistic concurrency、历史记录和 Agent 修改门禁。

## Agent 边界

当前已具备供 Agent 复用的结构：稳定 ID、类型化 payload、验证器、revision、树位置和语义操作 schema。思维导图读取已经进入 Agent 工具；幻灯片现在以 Slidev Markdown 和稳定 `nbId` 为边界，UML 和表格维持既有 canonical payload。三类视图的 Agent read/create/edit/convert 工具仍属于下一阶段。

后续接入必须遵守现有 Agent Runtime：先读取 canonical 来源和 revision，再生成目标或修改提案；写入必须经过本地 schema 校验、能力范围检查和用户确认，不允许模型直接写 SQLite，也不做静默跨视图同步。

## 代码与验证基线

截至 2026-07-28，事实边界由以下实现共同约束：

- `src/models/workspace`：Mind Map 与 `StructuredWorkspaceView` 类型、canonical payload 和 `pinnedAt`。
- `src/repositories/workspace` 与 `src/infrastructure/database/workspace`：CRUD、revision、树位置和结构化视图置顶。
- `src/features/workspace` 与 `src/composables/workspace`：统一内容树、编辑器、拖放和 `toggleWorkspaceViewPin`。
- `tests/frontend` 中对应 workspace model/repository/service/component 定向测试。

长期文档不保存某次全量测试数量。变更这组能力时，只运行受影响的定向测试、类型检查或 Rust migration 测试，并以当前 CI/提交记录追溯结果。
