import type { AgentToolDefinition } from '@/models/agentTool'
import { createDefaultExecutionPolicy, type ExecutionPolicy } from '@/models/executionPolicy'

export const AGENT_MAX_TOOL_ROUNDS = 6
export const AGENT_MAX_TOOL_FAILURES = 2
export const AGENT_MAX_TASK_DURATION_MS = 5 * 60 * 1000

export const AGENT_TOOL_REGISTRY: readonly AgentToolDefinition[] = [
  {
    name: 'get_current_document',
    description: '读取当前文档上下文。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 6,
  },
  {
    name: 'get_selected_blocks',
    description: '读取当前选中块。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 6,
  },
  {
    name: 'get_document_outline',
    description: '读取文档大纲。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 3,
  },
  {
    name: 'search_documents',
    description: '搜索本地知识库。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 6,
  },
  {
    name: 'read_document',
    description: '读取指定文档。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 6,
  },
  {
    name: 'find_blocks_by_regex',
    description: '使用受限正则在当前文档中定位块。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 4,
  },
  {
    name: 'read_skill_file',
    description: '读取已启用技能目录中的文本说明、脚本或参考文件。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 8,
  },
  {
    name: 'request_authorizer_input',
    description: '暂停 Agent，向授权人提出一个关键问题，并等待回答后继续。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 3,
  },
  {
    name: 'execute_shell',
    description: '执行白名单内的只读 Windows PowerShell 命令或本机工具。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 4,
  },
  {
    name: 'inspect_environment_paths',
    description: '检查当前用户进程可见的 PATH、PATHEXT 和 PSModulePath。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 2,
  },
  {
    name: 'discover_local_tools',
    description: '在 PATH 中发现指定或常见本机工具，不执行它们。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 3,
  },
  {
    name: 'get_system_info',
    description: '读取操作系统、架构、CPU 数量和当前工作目录。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 2,
  },
  {
    name: 'create_automation_draft',
    description: '经授权后创建停用的自动化草稿，不会排期或运行。',
    risk: 'draft',
    requiresConfirmation: true,
    maxCallsPerTask: 2,
  },
  {
    name: 'create_skill_draft',
    description: '经授权后创建停用的本地 Skill 草稿，不会立即加载到 Agent。',
    risk: 'draft',
    requiresConfirmation: true,
    maxCallsPerTask: 2,
  },
  {
    name: 'replace_text_by_regex',
    description: '以正则替换匹配块中的文本，并生成待确认 Patch。',
    risk: 'write',
    requiresConfirmation: true,
    maxCallsPerTask: 4,
  },
  {
    name: 'replace_block',
    description: '生成块替换 Patch。',
    risk: 'write',
    requiresConfirmation: true,
    maxCallsPerTask: 6,
  },
  {
    name: 'insert_blocks',
    description: '生成块插入 Patch。',
    risk: 'write',
    requiresConfirmation: true,
    maxCallsPerTask: 3,
  },
  {
    name: 'create_document',
    description: '生成新文档草案。',
    risk: 'write',
    requiresConfirmation: true,
    maxCallsPerTask: 2,
  },
]

export function getAgentToolDefinition(name: string): AgentToolDefinition | null {
  return AGENT_TOOL_REGISTRY.find((tool) => tool.name === name) ?? null
}

export function isAllowedAgentTool(name: string): boolean {
  return getAgentToolDefinition(name) !== null
}

export function createDefaultAgentExecutionPolicy(tokenBudget: number): ExecutionPolicy {
  return createDefaultExecutionPolicy({
    tokenBudget,
    allowedTools: [...AGENT_TOOL_REGISTRY.map((tool) => tool.name), 'mcp:*'],
  })
}
