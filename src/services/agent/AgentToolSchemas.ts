import { z } from 'zod'

import type { AgentToolDefinition } from '@/models/agent/agentTool'
import {
  createDocumentCommandSchema,
  createGroupCommandSchema,
  insertBlocksCommandSchema,
  regexReplaceCommandSchema,
  replaceBlockCommandSchema,
} from '@/services/agent/AgentWriteContract'
import { documentEditProposalSchema } from '@/services/ai/agentRuntime/agentRuntimeSchemas'

export const AGENT_TOOL_INPUT_SCHEMAS: Record<AgentToolDefinition['name'], z.ZodType> = {
  get_current_document: z.object({}),
  get_selected_blocks: z.object({}),
  get_document_outline: z.object({}),
  search_documents: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(10).optional(),
    scope: z.enum(['workspace', 'global']).optional(),
  }),
  list_document_groups: z.object({ query: z.string().max(160).optional() }),
  read_document: z.object({
    documentId: z.string().min(1),
    cursor: z.number().int().min(0).optional(),
    maxChars: z.number().int().min(4_096).max(65_536).optional(),
    blockIds: z.array(z.string().min(1)).max(100).optional(),
  }),
  list_mind_maps: z.object({}),
  read_mind_map: z.object({
    mindMapId: z.string().min(1),
    nodeId: z.string().min(1).optional(),
    depth: z.number().int().min(0).max(32).optional(),
    maxNodes: z.number().int().min(1).max(1_000).optional(),
    includeNotes: z.boolean().optional(),
    includeSources: z.boolean().optional(),
  }),
  find_blocks_by_regex: z.object({
    pattern: z.string().min(1).max(240),
    flags: z.string().optional(),
  }),
  read_skill_file: z.object({
    skillId: z.string().min(1).max(80),
    relativePath: z.string().min(1).max(500),
  }),
  request_authorizer_input: z.object({
    question: z.string().min(1).max(500),
    context: z.string().max(1_000).optional(),
    options: z.array(z.string().min(1).max(160)).min(2).max(5).optional(),
    allowFreeText: z.boolean().optional(),
  }),
  report_progress: z.object({
    summary: z.string().min(1).max(300),
    evidence: z.string().min(1).max(500),
    nextAction: z.string().min(1).max(300),
  }),
  execute_shell: z.object({
    command: z.enum([
      'Get-Process',
      'Get-Service',
      'Get-Command',
      'Get-Date',
      'git',
      'rg',
      'where.exe',
      'node',
      'pnpm',
      'npm',
      'python',
      'cargo',
      'rustc',
    ]),
    args: z.array(z.string().max(500)).max(12).optional(),
    timeoutMs: z.number().int().min(1_000).max(30_000).optional(),
    maxOutputChars: z.number().int().min(4_096).max(65_536).optional(),
  }),
  inspect_environment_paths: z.object({}),
  discover_local_tools: z.object({
    names: z.array(z.string().min(1).max(80)).max(32).optional(),
  }),
  get_system_info: z.object({}),
  create_automation_draft: z.object({
    name: z.string().min(1).max(120),
    instruction: z.string().min(1).max(8_000),
    triggerType: z.enum(['manual', 'interval', 'daily']),
    intervalMinutes: z.number().int().min(5).max(10_080).optional(),
    dailyTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    bindCurrentDocument: z.boolean().optional(),
  }),
  create_skill_draft: z.object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    instructions: z.string().min(1).max(24_000),
  }),
  create_mcp_server_draft: z.object({
    name: z.string().min(1).max(120),
    transport: z.enum(['stdio', 'http']),
    command: z.string().min(1).max(1_000).optional(),
    args: z.array(z.string().max(2_000)).max(64).optional(),
    cwd: z.string().min(1).max(2_000).optional(),
    url: z.string().url().max(4_000).optional(),
  }),
  replace_text_by_regex: regexReplaceCommandSchema.omit({ tool: true }),
  replace_block: replaceBlockCommandSchema.omit({ tool: true }),
  insert_blocks: insertBlocksCommandSchema.omit({ tool: true }),
  create_document: createDocumentCommandSchema.omit({ tool: true }),
  create_group: createGroupCommandSchema.omit({ tool: true }),
  submit_document_edits: documentEditProposalSchema,
}

export function getAgentToolJsonSchema(name: AgentToolDefinition['name']): Record<string, unknown> {
  return z.toJSONSchema(AGENT_TOOL_INPUT_SCHEMAS[name]) as Record<string, unknown>
}
