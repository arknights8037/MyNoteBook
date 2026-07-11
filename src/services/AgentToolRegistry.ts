import type { AgentToolDefinition } from '@/models/agentTool'

export const AGENT_MAX_TOOL_ROUNDS = 6
export const AGENT_MAX_TOOL_FAILURES = 2
export const AGENT_MAX_TASK_DURATION_MS = 5 * 60 * 1000

export const AGENT_TOOL_REGISTRY: readonly AgentToolDefinition[] = [
  { name: 'get_current_document', description: '读取当前文档上下文。', risk: 'read', requiresConfirmation: false, maxCallsPerTask: 6 },
  { name: 'get_selected_blocks', description: '读取当前选中块。', risk: 'read', requiresConfirmation: false, maxCallsPerTask: 6 },
  { name: 'get_document_outline', description: '读取文档大纲。', risk: 'read', requiresConfirmation: false, maxCallsPerTask: 3 },
  { name: 'search_documents', description: '搜索本地知识库。', risk: 'read', requiresConfirmation: false, maxCallsPerTask: 6 },
  { name: 'read_document', description: '读取指定文档。', risk: 'read', requiresConfirmation: false, maxCallsPerTask: 6 },
  { name: 'find_blocks_by_regex', description: '使用受限正则在当前文档中定位块。', risk: 'read', requiresConfirmation: false, maxCallsPerTask: 4 },
  { name: 'replace_text_by_regex', description: '以正则替换匹配块中的文本，并生成待确认 Patch。', risk: 'write', requiresConfirmation: true, maxCallsPerTask: 4 },
  { name: 'replace_block', description: '生成块替换 Patch。', risk: 'write', requiresConfirmation: true, maxCallsPerTask: 6 },
  { name: 'insert_blocks', description: '生成块插入 Patch。', risk: 'write', requiresConfirmation: true, maxCallsPerTask: 3 },
  { name: 'create_document', description: '生成新文档草案。', risk: 'write', requiresConfirmation: true, maxCallsPerTask: 2 },
]

export function getAgentToolDefinition(name: string): AgentToolDefinition | null {
  return AGENT_TOOL_REGISTRY.find((tool) => tool.name === name) ?? null
}

export function isAllowedAgentTool(name: string): boolean {
  return getAgentToolDefinition(name) !== null
}
