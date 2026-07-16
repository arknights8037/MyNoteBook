import type { AgentToolDefinition } from '@/models/agentTool'
import { createDefaultExecutionPolicy, type ExecutionPolicy } from '@/models/executionPolicy'

export const AGENT_MAX_TOOL_ROUNDS = 32
export const AGENT_MAX_TOOL_FAILURES = 6
export const AGENT_MAX_TASK_DURATION_MS = 10 * 60 * 1000

export const AGENT_TOOL_REGISTRY: readonly AgentToolDefinition[] = [
  {
    name: 'get_current_document',
    description: '读取当前文档、revision 和稳定块；仅在用户明确指向当前页面时使用。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 16,
    tags: ['document.read'],
  },
  {
    name: 'get_selected_blocks',
    description: '读取用户真实选择的块；没有选区时返回空数组。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 12,
    tags: ['document.read'],
  },
  {
    name: 'get_document_outline',
    description: '读取当前文档标题大纲及稳定 block id，不返回完整正文。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 8,
    tags: ['document.read'],
  },
  {
    name: 'search_documents',
    description:
      '搜索本地知识库；默认限定当前项目工作区，证据不足时可用 scope=global 主动扩大到全库。返回片段只用于定位，结论前应读取文档。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 16,
    tags: ['knowledge.read'],
  },
  {
    name: 'list_document_groups',
    description: '列出或按名称筛选知识库分组，并返回真实父级 ID。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 8,
    tags: ['knowledge.read'],
  },
  {
    name: 'read_document',
    description: '按文档 ID 分页读取 revision、canonical Markdown 和稳定 block id；结果截断时使用 nextCursor，已知目标块时使用 blockIds。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 20,
    tags: ['document.read'],
  },
  {
    name: 'list_mind_maps',
    description: '列出本地思维导图及其稳定 ID、节点数和版本，用于定位需要查询的导图。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 8,
    tags: ['knowledge.read'],
  },
  {
    name: 'read_mind_map',
    description: '按稳定节点 ID 分层读取思维导图子树；可限制深度和节点数，并按需包含注释与来源。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 16,
    tags: ['knowledge.read'],
  },
  {
    name: 'find_blocks_by_regex',
    description: '使用受限线性时间正则表达式定位当前文档中的稳定块。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 12,
    tags: ['document.read'],
  },
  {
    name: 'read_skill_file',
    description: '读取已启用 Skill 目录中的 UTF-8 文本；skillId 和相对路径必须来自已启用技能目录。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 16,
    tags: ['system.inspect'],
  },
  {
    name: 'request_authorizer_input',
    description: '仅在目标、范围、结构或写入位置需要授权人决策时暂停任务，收到回答后继续同一次运行。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 6,
    tags: ['cognition.interact'],
  },
  {
    name: 'execute_shell',
    description: '执行 Runtime 白名单内的只读 Windows 查询、Git/rg 检索或开发工具版本命令；不接受脚本文本。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 8,
    tags: ['system.inspect'],
  },
  {
    name: 'inspect_environment_paths',
    description: '检查当前用户进程可见的 PATH、PATHEXT 和 PSModulePath。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 4,
    tags: ['system.inspect'],
  },
  {
    name: 'discover_local_tools',
    description: '在 PATH 中发现指定或常见本机工具，不执行它们。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 6,
    tags: ['system.inspect'],
  },
  {
    name: 'get_system_info',
    description: '读取操作系统、架构、CPU 数量和当前工作目录。',
    risk: 'read',
    requiresConfirmation: false,
    maxCallsPerTask: 4,
    tags: ['system.inspect'],
  },
  {
    name: 'create_automation_draft',
    description: '用户明确要求创建自动化时，经授权创建停用草稿；不会运行或排期。',
    risk: 'draft',
    requiresConfirmation: true,
    maxCallsPerTask: 2,
    tags: ['external.may_write'],
  },
  {
    name: 'create_skill_draft',
    description: '用户明确要求创建可复用 Skill 时，经授权写入停用草稿；不会立即加载。',
    risk: 'draft',
    requiresConfirmation: true,
    maxCallsPerTask: 2,
    tags: ['external.may_write'],
  },
  {
    name: 'replace_text_by_regex',
    description: '提交受限正则文本替换提案；只进入确认队列，不会立即写入。',
    risk: 'write',
    requiresConfirmation: true,
    maxCallsPerTask: 4,
    tags: ['document.propose_write'],
  },
  {
    name: 'replace_block',
    description: '使用本次读取的稳定 blockId 提交完整块替换提案；不会立即写入。',
    risk: 'write',
    requiresConfirmation: true,
    maxCallsPerTask: 6,
    tags: ['document.propose_write'],
  },
  {
    name: 'insert_blocks',
    description: '使用本次读取的稳定 anchorBlockId 提交插入提案；不会立即写入。',
    risk: 'write',
    requiresConfirmation: true,
    maxCallsPerTask: 3,
    tags: ['document.propose_write'],
  },
  {
    name: 'create_document',
    description: '提交一篇正文完整的新文档提案；父级 ID 必须来自本次读取，不会立即写入。',
    risk: 'write',
    requiresConfirmation: true,
    maxCallsPerTask: 2,
    tags: ['document.propose_write'],
  },
  {
    name: 'create_group',
    description: '提交新分组提案，可包含一篇完整初始文档；不会立即写入。',
    risk: 'write',
    requiresConfirmation: true,
    maxCallsPerTask: 2,
    tags: ['document.propose_write'],
  },
  {
    name: 'submit_document_edits',
    description: '按文档分组提交一批复杂或跨文档修改；目标必须来自本次读取且互不重叠，只进入确认队列。',
    risk: 'write',
    requiresConfirmation: true,
    maxCallsPerTask: 2,
    tags: ['document.propose_write'],
  },
]

export function getAgentToolDefinition(name: string): AgentToolDefinition | null {
  return AGENT_TOOL_REGISTRY.find((tool) => tool.name === name) ?? null
}

export function isAllowedAgentTool(name: string): boolean {
  return getAgentToolDefinition(name) !== null
}

export const MIN_AGENT_WRITE_OUTPUT_TOKENS = 16_384

export function createDefaultAgentExecutionPolicy(tokenBudget: number): ExecutionPolicy {
  return createDefaultExecutionPolicy({
    tokenBudget: Math.max(tokenBudget, MIN_AGENT_WRITE_OUTPUT_TOKENS),
    allowedTools: [...AGENT_TOOL_REGISTRY.map((tool) => tool.name), 'mcp:*'],
  })
}

export function resolveAgentOutputTokenLimit(
  configuredMaxTokens: number,
  policy: ExecutionPolicy,
): number {
  const requested = policy.allowWriteProposals
    ? Math.max(configuredMaxTokens, MIN_AGENT_WRITE_OUTPUT_TOKENS)
    : configuredMaxTokens
  return Math.min(requested, policy.tokenBudget)
}
