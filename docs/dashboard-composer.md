# 可组合情报与工作看板

> 状态（实现于 2026-07-28）：P0 已落地。信息面板现在是工作区一级视图，使用 Grid Layout Plus、`workspace_views` 的版本化持久化，以及显式 Widget 注册表。当前内置“自动化结果”和“Agent 工作状态”两个只读组件；P1 及以后能力仍是规划，不描述为现有能力。

## 1. 产品定位

看板是 MyNoteBook 的可配置工作首页，用于回答四个问题：

1. 外部发生了什么；
2. 哪些工作正在推进；
3. 什么需要用户判断；
4. 下一步可以交给哪个人或 Agent。

它提供类似 Notion 看板的自由组合体验，但不复制 Notion 的通用数据库。Widget 是现有业务状态的视图和受控操作入口，Automation、Work、Knowledge、Agent、RSS、Audit 等领域仍拥有各自的 canonical 数据。独立首页已使用单例 `information_home` 落地，不再借用第一个普通 Dashboard；用户创建的 Dashboard 仍由 `workspace_views` 管理。

## 2. 核心体验

### 浏览模式

- 页面默认只展示信息，不出现拖拽手柄和配置噪声。
- 卡片可以刷新、展开、跳转来源或发起明确的后续动作。
- 数据必须显示更新时间、来源范围、失败状态和权限状态。
- 高风险操作继续进入现有授权、提案、确认和审计流程。

### 编辑模式

- 用户从 Widget 库添加卡片。
- 卡片支持拖拽、缩放、复制、移除和配置。
- 页面支持保存、撤销本轮布局、恢复默认布局。
- 布局使用固定列网格，避免自由像素定位导致重叠和窗口适配问题。
- 窄窗口按断点转换布局，不能简单压缩桌面坐标。

### 咨询与决策

- 用户可以针对整个看板、某个项目或选中的卡片咨询 Agent。
- 卡片只提供结构化上下文引用，不直接拼接未经限制的全部数据。
- Agent 结论可以转为 Research Candidate、Decision、Task 或文档草稿。
- 自动化执行不自动化责任：写入、批准、外发和高风险动作仍需确认。

## 3. 首批 Widget

| Widget             | 主要信息                                                          | 主要动作                             |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------ |
| RSS Briefing       | 未读更新、增量摘要、主题聚类、来源异常、自上次阅读以来的变化      | 标记已读、加入项目、创建 Research    |
| Signal Inbox       | RSS、IM、MCP 和外部系统信号                                       | 关联项目、提取任务、归档、咨询 Agent |
| Automation Results | queued、running、completed、failed、输出摘要、下次运行时间        | 查看日志、重试、暂停、创建后续任务   |
| Agent Work Status  | 多任务运行状态、等待用户、等待外部结果、失败和已完成              | 打开会话、停止任务、回答授权问题     |
| Decision Queue     | Research Candidate、Review Issue、ChangeSet、Approval、待验证结果 | 批准、拒绝、请求补充证据             |
| Project Context    | 项目目标、近期决策、开放问题、活跃任务和最近成果                  | 打开项目、更新目标、委派任务         |
| Ask Agent          | 当前看板、项目或卡片的咨询入口                                    | 生成 Research、Decision、Task 或文档 |

第二阶段再考虑日历、会议、邮件、指标图表和外部 SaaS 卡片。首期不追求 Widget 数量，先保证来源、状态、动作和权限边界一致。

## 4. 页面与数据模型

看板只持久化页面定义、Widget 配置和布局，不复制业务数据：

```ts
interface DashboardPage {
  id: string
  title: string
  scope: { kind: 'global' | 'project'; projectId?: string }
  layoutVersion: number
  widgets: DashboardWidgetInstance[]
  createdAt: number
  updatedAt: number
}

interface DashboardWidgetInstance {
  id: string
  widgetType: string
  widgetVersion: number
  query: Record<string, unknown>
  settings: Record<string, unknown>
  layout: {
    desktop: GridPosition
    compact?: GridPosition
  }
}

interface GridPosition {
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}
```

约束：

- `widgetType + widgetVersion` 决定组件与配置迁移器。
- `query` 只能描述允许的数据范围，不能保存 SQL、脚本或任意 URL 请求。
- Widget 从 service/repository 的只读查询端口获取数据。
- 写操作调用正式 command，不允许 Widget 直接写 SQLite。
- 布局更新使用 revision/optimistic concurrency，避免多窗口覆盖。

## 5. Vue 组件组织

看板已作为独立 feature 实现，没有把卡片逻辑堆进工作区页面：

```text
src/features/dashboard/
├─ dashboardWidgetRegistry.ts
└─ components/
   ├─ DashboardSurface.vue
   ├─ DashboardGrid.vue
   ├─ DashboardWidgetFrame.vue
   ├─ DashboardWidgetHost.vue
   ├─ DashboardWidgetLibrary.vue
   ├─ AutomationResultsWidget.vue
   └─ AgentWorkStatusWidget.vue
```

当前两个只读 Widget 直接使用独立组件和既有 service 查询端口；注册表只接受随应用编译的固定类型。组件数量增长或出现独立配置 schema 后，再按 Widget 拆分文件夹、查询适配器和定向测试。

## 6. 布局引擎选型

### 已选：Grid Layout Plus

P0 使用 [Grid Layout Plus 官方站点](https://grid-layout-plus.netlify.app/)所述的 Vue 3 原生网格能力。选择原因是组件生命周期与现有 Vue 工作区一致，并直接覆盖拖拽、缩放、紧凑排列、序列化和响应式布局。桌面布局与 compact 布局分别保存，窄窗口切换不会覆盖桌面坐标。

### 备选：GridStack 适配层

[GridStack 官方文档](https://gridstackjs.com/)提供拖拽、缩放、响应式列、保存/恢复、跨网格和嵌套网格能力，并提供 Vue 集成。它适合桌面 Dashboard Composer，但业务代码不应直接依赖第三方节点结构，应通过 `DashboardGridAdapter` 转换为自己的 `GridPosition`。

候选理由：

- 交互能力完整，适合桌面级复杂排版；
- 布局可序列化，便于本地持久化和迁移；
- 框架耦合较低，未来可以替换而不改变 Widget 协议；
- 响应式、最小尺寸和锁定能力满足受控布局需求。

需要验证：

- Tauri WebView 中拖拽、缩放与高 DPI 的稳定性；
- Vue 组件挂载/卸载是否会被 GridStack DOM 生命周期干扰；
- 大量实时 Widget 更新时的渲染成本；
- 键盘操作、焦点顺序和无障碍替代操作。

不建议首期自行实现碰撞、压缩、响应式迁移和缩放算法。这些边缘情况会快速超过普通拖拽列表的复杂度。

## 7. 安全与插件边界

首期禁止用户直接导入任意 `.vue`、JavaScript、HTML、iframe 或 SQL 作为 Widget。允许的扩展方式是：

1. 应用内置 Widget 通过注册表声明；
2. 声明可读数据类型、可调用动作、最小/最大尺寸和配置 schema；
3. 运行时校验配置版本和权限；
4. 外部数据先进入 RSS、IM、MCP 或其他集成服务，再由 Widget 查询；
5. Plugin Widget 属于后续阶段，必须经过安装、启用、签名/来源和能力校验。

## 8. 分阶段落地

### P0：布局基础

- [x] 采用 Grid Layout Plus，并以应用模型隔离第三方布局结构；
- [x] Dashboard 工作区页面和 SQLite 持久化（复用 `workspace_views` 的 revision/optimistic concurrency）；
- [x] 编辑/浏览模式；
- [x] 添加、移动、缩放、复制、删除、保存、撤销和恢复默认布局；
- [x] Widget 注册表、组件级错误边界、加载态和空状态；
- [x] Automation Results 与 Agent Work Status 两个只读 Widget；
- [ ] WebView2 高 DPI 与键盘替代操作的人工验收。

### P1：情报入口

- RSS source、抓取状态、去重和增量摘要；
- RSS Briefing 与 Signal Inbox；
- 信息关联项目、创建 Research/Task；
- 来源时间、失败和权限提示。

### P2：决策闭环

- Decision Queue 与 Ask Agent；
- 卡片选择形成受控 Context Bundle；
- Research、Review、Approval 与 Work 状态回写；
- 看板模板和项目级默认布局。

### P3：受控扩展

- Plugin Widget manifest 与权限声明；
- 配置迁移、版本兼容和禁用降级；
- 可导入/导出的纯布局模板，不携带敏感业务数据。

## 9. 验收标准

- 重新启动应用后布局、配置和卡片身份保持稳定。
- Widget 故障只影响自身，不能使整个看板白屏。
- 卡片刷新不会改变用户布局。
- 窄窗口不重叠、不越界，并可恢复桌面布局。
- 删除 Widget 不删除其来源业务数据。
- 未授权 Widget 无法读取或执行未声明能力。
- Automation、Agent、Decision 卡片能定位到 canonical 记录。
- Ask Agent 使用明确的卡片/项目范围，不静默扩大上下文。
- 所有写入继续经过现有 command、revision、确认与审计边界。

## 10. 可行性结论

方案可行，且与当前 Vue 3 + Tauri + SQLite 架构兼容。真正的难点不在拖拽排版，而在 Widget 数据协议、权限、刷新生命周期、响应式布局迁移和跨领域动作的一致性。

建议从“两个只读状态 Widget + 一个 12 列布局页”开始验证，不先建设任意组件市场，也不把看板变成第二套数据库。这样可以尽快获得视觉化工作中枢，同时保留后续 RSS、IM、Agent 和 Work 扩展空间。
