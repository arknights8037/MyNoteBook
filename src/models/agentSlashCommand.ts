import type { AiChatMode } from './aiChatMode'

export type AgentRunIntent =
  | 'default'
  | 'plan'
  | 'create'
  | 'research'
  | 'review'
  | 'learning'
  | 'interactive'

export interface AgentSlashCommand {
  name: string
  label: string
  description: string
  mode: AiChatMode
  intent: AgentRunIntent
  placeholder: string
  defaultPrompt: string
  systemInstruction: string
}

export interface ResolvedAgentSlashCommand {
  command: AgentSlashCommand
  prompt: string
  originalPrompt: string
}

export const AGENT_SLASH_COMMANDS: readonly AgentSlashCommand[] = [
  {
    name: 'plan',
    label: '计划模式',
    description: '先澄清目标并输出可执行计划，不生成修改',
    mode: 'agent',
    intent: 'plan',
    placeholder: '描述需要规划的目标',
    defaultPrompt: '请根据当前页面制定一份可执行计划。',
    systemInstruction:
      '当前为计划模式。只分析、查证和制定分步骤计划，禁止生成 commands 或 patches；最终 outcome 必须为 no_change，并把完整计划写入 finalAnswer。关键目标不明确时先向授权人提问。',
  },
  {
    name: 'create',
    label: '创建模式',
    description: '创建一个新页面，并在写入前等待确认',
    mode: 'agent',
    intent: 'create',
    placeholder: '描述要创建的页面和内容',
    defaultPrompt: '请根据当前页面创建一篇结构完整的新文档。',
    systemInstruction:
      '当前为创建模式。最终只能提出一个 create_document command，不能修改当前文档，也不能与其他 command 或 patch 混用。标题、位置或范围不明确时先向授权人提问。',
  },
  {
    name: 'interactive',
    label: '授权问答',
    description: '模型先询问授权人，再继续执行同一次任务',
    mode: 'agent',
    intent: 'interactive',
    placeholder: '描述任务，模型会先确认关键决策',
    defaultPrompt: '请先向我确认执行方式，再处理当前页面。',
    systemInstruction:
      '当前为授权人互动模式。在提出任何修改前，必须使用 request_authorizer_input 就最关键的决策向授权人提问，并依据回答继续同一次任务。',
  },
  {
    name: 'research',
    label: '调研模式',
    description: '检索知识库并整理结论，不修改内容',
    mode: 'agent',
    intent: 'research',
    placeholder: '描述需要查证或对比的问题',
    defaultPrompt: '请检索知识库并整理与当前页面相关的事实和结论。',
    systemInstruction:
      '当前为调研模式。必须按需检索和阅读资料，但禁止生成 commands 或 patches；最终 outcome 必须为 no_change，并在 finalAnswer 中给出带依据的调研结论。',
  },
  {
    name: 'review',
    label: '审阅模式',
    description: '只读检查事实、来源和逻辑问题',
    mode: 'agent',
    intent: 'review',
    placeholder: '说明审阅重点，例如结构、事实或表达',
    defaultPrompt: '请审阅当前页面，列出可定位的问题、严重程度和建议动作。',
    systemInstruction:
      '当前为只读 Review Mode。输出结构化问题，不生成修改提案；只有用户稍后明确选择处理某项问题时，才进入独立的 Patch 提案运行。',
  },
  {
    name: 'learn',
    label: '学习模式',
    description: '先解释或作答，再获得逐步反馈与提示',
    mode: 'agent',
    intent: 'learning',
    placeholder: '输入希望理解的主题或当前困惑',
    defaultPrompt: '请围绕当前页面选择一个核心概念，引导我先用自己的话解释。',
    systemInstruction:
      '当前为 Learning Mode。首次只提出问题并等待用户尝试；后续依据持久化 Learning Session 分析尝试，不直接写文档或正式知识。',
  },
  {
    name: 'find-assumptions',
    label: '查找假设',
    description: '使用 Review Mode 聚焦范围和隐含假设',
    mode: 'agent',
    intent: 'review',
    placeholder: '补充需要关注的章节或范围',
    defaultPrompt: '聚焦检查当前页面中缺失的范围、前提和隐含假设。',
    systemInstruction: '使用 Review Mode，并将本次任务聚焦于范围与假设。',
  },
  {
    name: 'find-conflicts',
    label: '查找冲突',
    description: '使用 Review Mode 聚焦内部或来源冲突',
    mode: 'agent',
    intent: 'review',
    placeholder: '补充需要比较的观点或资料',
    defaultPrompt: '聚焦检查当前页面及相关来源中的内部冲突。',
    systemInstruction: '使用 Review Mode，并将本次任务聚焦于冲突。',
  },
  {
    name: 'extract-claims',
    label: '检查结论',
    description: '使用 Review Mode 聚焦结论及其证据',
    mode: 'agent',
    intent: 'review',
    placeholder: '补充需要检查的结论范围',
    defaultPrompt: '聚焦提取并检查当前页面中的结论、来源和证据支持情况。',
    systemInstruction: '使用 Review Mode，并将本次任务聚焦于结论与证据。',
  },
  {
    name: 'edit',
    label: '编辑模式',
    description: '直接针对当前页面生成可确认修改',
    mode: 'edit',
    intent: 'default',
    placeholder: '描述希望怎样修改当前页面',
    defaultPrompt: '请改进当前页面的内容。',
    systemInstruction: '',
  },
  {
    name: 'ask',
    label: '问答模式',
    description: '只读回答，不产生任何修改提案',
    mode: 'ask',
    intent: 'default',
    placeholder: '输入关于当前页面的问题',
    defaultPrompt: '请总结当前页面。',
    systemInstruction: '',
  },
] as const

export function resolveAgentSlashCommand(value: string): ResolvedAgentSlashCommand | null {
  const originalPrompt = value.trim()
  const match = originalPrompt.match(/^\/([a-z-]+)(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  const command = AGENT_SLASH_COMMANDS.find(
    (candidate) => candidate.name === match[1]?.toLocaleLowerCase(),
  )
  if (!command) return null
  return {
    command,
    prompt: match[2]?.trim() || command.defaultPrompt,
    originalPrompt,
  }
}

export function filterAgentSlashCommands(value: string): readonly AgentSlashCommand[] {
  const match = value.match(/^\/([^\s/]*)$/)
  if (!match) return []
  const query = match[1]?.toLocaleLowerCase() ?? ''
  return AGENT_SLASH_COMMANDS.filter((command) =>
    `${command.name} ${command.label} ${command.description}`.toLocaleLowerCase().includes(query),
  )
}
