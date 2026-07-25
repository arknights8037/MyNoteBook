import { jsonSchema, tool, type ToolSet } from 'ai'
import { z } from 'zod'

import { AGENT_TOOL_REGISTRY } from '@/services/agent/AgentToolRegistry'
import { redactSensitiveText } from '@/services/security/SensitiveDataRedaction'
import {
  createDocumentCommandSchema,
  createGroupCommandSchema,
  insertBlocksCommandSchema,
  regexReplaceCommandSchema,
  replaceBlockCommandSchema,
} from '@/services/agent/AgentWriteContract'
import { policyAllowsToolName } from '@/services/agent/AgentToolLifecycle'
import type { ExecutionPolicy } from '@/models/agent/executionPolicy'
import { documentEditProposalSchema } from './agentRuntimeSchemas'
import {
  captureCommand,
  captureDocumentEdits,
  execute,
  type ToolLifecycleContext,
} from './agentRuntimeToolLifecycle'

/**
 * Builds the full ToolSet for the agent runtime, including built-in tools,
 * registry description overrides, and external MCP tools.
 */
export function buildAgentToolSet(
  ctx: ToolLifecycleContext,
  policy: ExecutionPolicy,
): { activeToolSet: ToolSet; activeToolNames: string[] } {
  const tools: ToolSet = {
    get_current_document: tool({
      description: '读取当前文档、revision 和稳定块。',
      inputSchema: z.object({}),
      execute: (args) => execute(ctx, 'get_current_document', args),
    }),
    get_selected_blocks: tool({
      description: '读取用户真实选择的块；没有选区时返回空数组。',
      inputSchema: z.object({}),
      execute: (args) => execute(ctx, 'get_selected_blocks', args),
    }),
    get_document_outline: tool({
      description: '读取当前文档标题大纲及稳定 block id。',
      inputSchema: z.object({}),
      execute: (args) => execute(ctx, 'get_document_outline', args),
    }),
    search_documents: tool({
      description:
        '搜索本地知识库。默认 scope=workspace，只检索当前项目配置的文档分组；当工作区证据不足时可主动改用 scope=global 扩大到全库，并在过程里说明扩大原因。',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional(),
        scope: z.enum(['workspace', 'global']).optional(),
      }),
      execute: (args) => execute(ctx, 'search_documents', args),
    }),
    list_document_groups: tool({
      description:
        '列出或按名称筛选知识库分组，返回真实 group id、标题和子项数量。需要把文档创建到指定分组时先调用本工具，不要猜测父级字段或 ID。',
      inputSchema: z.object({ query: z.string().max(160).optional() }),
      execute: (args) => execute(ctx, 'list_document_groups', args),
    }),
    read_document: tool({
      description:
        '按文档 ID 分页读取知识库块，返回 revision、canonical Markdown 和稳定 block id。结果截断时使用 nextCursor 继续；已知目标块时优先传 blockIds。',
      inputSchema: z.object({
        documentId: z.string().min(1),
        cursor: z.number().int().min(0).optional(),
        maxChars: z.number().int().min(4_096).max(65_536).optional(),
        blockIds: z.array(z.string().min(1)).max(100).optional(),
      }),
      execute: (args) => execute(ctx, 'read_document', args),
    }),
    list_mind_maps: tool({
      description: '列出本地思维导图的 ID、标题、节点数和当前版本。',
      inputSchema: z.object({}),
      execute: (args) => execute(ctx, 'list_mind_maps', args),
    }),
    read_mind_map: tool({
      description:
        '读取一张思维导图或指定节点下的子树。先通过 list_mind_maps 获取真实 mindMapId；大图应限制 depth/maxNodes 并继续按 nodeId 查询。',
      inputSchema: z.object({
        mindMapId: z.string().min(1),
        nodeId: z.string().min(1).optional(),
        depth: z.number().int().min(0).max(32).optional(),
        maxNodes: z.number().int().min(1).max(1_000).optional(),
        includeNotes: z.boolean().optional(),
        includeSources: z.boolean().optional(),
      }),
      execute: (args) => execute(ctx, 'read_mind_map', args),
    }),
    find_blocks_by_regex: tool({
      description: '使用受限正则表达式定位当前文档中的块。',
      inputSchema: z.object({ pattern: z.string().min(1).max(240), flags: z.string().optional() }),
      execute: (args) => execute(ctx, 'find_blocks_by_regex', args),
    }),
    read_skill_file: tool({
      description:
        '读取用户已启用技能目录中的 UTF-8 文本文件。只接受已启用技能 ID 和该技能文件树中的相对路径。',
      inputSchema: z.object({
        skillId: z.string().min(1).max(80),
        relativePath: z.string().min(1).max(500),
      }),
      execute: (args) => execute(ctx, 'read_skill_file', args),
    }),
    request_authorizer_input: tool({
      description:
        '当关键目标、范围、结构或写入位置需要授权人决策时，暂停任务并等待授权人回答。不要询问可从上下文或只读工具自行确定的事实。',
      inputSchema: z.object({
        question: z.string().min(1).max(500),
        context: z.string().max(1_000).optional(),
        options: z.array(z.string().min(1).max(160)).min(2).max(5).optional(),
        allowFreeText: z.boolean().optional(),
      }),
      execute: (args) => execute(ctx, 'request_authorizer_input', args),
    }),
    report_progress: tool({
      description:
        '向用户显示当前阶段的可审计决策摘要。summary 说明当前判断，evidence 只引用已观察到的事实或工具返回，nextAction 说明下一步；不要写隐藏思维链、逐步内心推理或未经观察的猜测。',
      inputSchema: z.object({
        summary: z.string().min(1).max(300),
        evidence: z.string().min(1).max(500),
        nextAction: z.string().min(1).max(300),
      }),
      execute: (args) =>
        execute(ctx, 'report_progress', args, {
          internalExecute: async () => {
            const summary = redactSensitiveText(args.summary)
            const evidence = redactSensitiveText(args.evidence)
            const nextAction = redactSensitiveText(args.nextAction)
            const occurredAt = Date.now()
            ctx.input.onProgress?.({
              phase: 'planning',
              toolName: 'report_progress',
              detail: summary,
              timelineEvent: {
                id: `decision:${ctx.input.taskId}:${ctx.activeStepNumber}`,
                kind: 'decision',
                status: 'completed',
                detail: `${summary}\n依据：${evidence}\n下一步：${nextAction}`,
                occurredAt: ctx.stepStartedAt.get(ctx.activeStepNumber) ?? occurredAt,
                completedAt: occurredAt,
                stepNumber: ctx.activeStepNumber + 1,
              },
            })
            return { ok: true, value: { visibleToUser: true } }
          },
        }),
    }),
    execute_shell: tool({
      description:
        '执行受限的只读 Windows 命令。command 仅可为 Get-Process、Get-Service、Get-Command、Get-Date、git、rg、where.exe、node、pnpm、npm、python、cargo、rustc；args 仍受本机白名单校验。',
      inputSchema: z.object({
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
      execute: (args) => execute(ctx, 'execute_shell', args),
    }),
    inspect_environment_paths: tool({
      description:
        '读取当前进程可见的 PATH、PATHEXT、PSModulePath，返回拆分后的路径和存在性；不会读取其他环境变量。',
      inputSchema: z.object({}),
      execute: (args) => execute(ctx, 'inspect_environment_paths', args),
    }),
    discover_local_tools: tool({
      description:
        '扫描 PATH 并发现本机工具，不执行工具。names 为空时检查常见开发工具；也可提供最多 32 个安全工具名。',
      inputSchema: z.object({ names: z.array(z.string().min(1).max(80)).max(32).optional() }),
      execute: (args) => execute(ctx, 'discover_local_tools', args),
    }),
    get_system_info: tool({
      description: '读取操作系统、CPU 架构、逻辑 CPU 数和应用当前工作目录，不读取用户密钥。',
      inputSchema: z.object({}),
      execute: (args) => execute(ctx, 'get_system_info', args),
    }),
    create_automation_draft: tool({
      description:
        '用户明确要求创建自动化时使用。工具会先请求用户确认，然后只创建停用草稿，不会运行或排期。创建成功后最终结果使用 no_change，并说明可前往自动化任务页审阅启用。',
      inputSchema: z.object({
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
      execute: (args) => execute(ctx, 'create_automation_draft', args),
    }),
    create_skill_draft: tool({
      description:
        '用户明确要求创建可复用 Skill 时使用。工具会先请求用户确认，然后写入停用草稿；instructions 应包含完整触发条件、步骤和边界。创建成功后最终结果使用 no_change，并提示到插件技能页审阅启用。',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        description: z.string().min(1).max(500),
        instructions: z.string().min(1).max(24_000),
      }),
      execute: (args) => execute(ctx, 'create_skill_draft', args),
    }),
    create_mcp_server_draft: tool({
      description:
        '用户明确要求添加 MCP 服务时使用。工具会先请求确认，再写入停用且未信任的配置草稿；不会连接、启动或加载该服务。不要把令牌、密码、Cookie 或 Authorization header 放入参数。',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        transport: z.enum(['stdio', 'http']),
        command: z.string().min(1).max(1_000).optional(),
        args: z.array(z.string().max(2_000)).max(64).optional(),
        cwd: z.string().min(1).max(2_000).optional(),
        url: z.string().url().max(4_000).optional(),
      }),
      execute: (args) => execute(ctx, 'create_mcp_server_draft', args),
    }),
    replace_text_by_regex: tool({
      description:
        '提交一个正则文本替换提案，进入用户确认队列；不会立即写入。仅在已经读取并确认目标范围后调用。',
      inputSchema: regexReplaceCommandSchema.omit({ tool: true }),
      execute: (args) => captureCommand(ctx, { tool: 'replace_text_by_regex', ...args }),
    }),
    replace_block: tool({
      description:
        '提交一个完整块替换提案，进入用户确认队列；不会立即写入。blockId 必须来自本次读取结果。',
      inputSchema: replaceBlockCommandSchema.omit({ tool: true }),
      execute: (args) => captureCommand(ctx, { tool: 'replace_block', ...args }),
    }),
    insert_blocks: tool({
      description:
        '提交一个块插入提案，进入用户确认队列；不会立即写入。anchorBlockId 必须来自本次读取结果。',
      inputSchema: insertBlocksCommandSchema.omit({ tool: true }),
      execute: (args) => captureCommand(ctx, { tool: 'insert_blocks', ...args }),
    }),
    create_document: tool({
      description:
        '提交一篇完整新文档的待确认提案，不会立即写入。若要指定父级，只能使用已经通过工具读取到的真实 parentDocumentId；未知时先读取或询问，不得猜测字段。',
      inputSchema: createDocumentCommandSchema.omit({ tool: true }),
      execute: (args) => captureCommand(ctx, { tool: 'create_document', ...args }),
    }),
    create_group: tool({
      description:
        '提交新分组提案，可通过 initialDocument 同时提交首篇完整文档；进入用户确认队列，不会立即写入。',
      inputSchema: createGroupCommandSchema.omit({ tool: true }),
      execute: (args) => captureCommand(ctx, { tool: 'create_group', ...args }),
    }),
    submit_document_edits: tool({
      description:
        '提交一个或多个文档的待确认修改，不会立即写入。每个文档只声明一次 documentId；replace 使用 targetBlockIds，插入使用 anchorBlockId。同一文档内一个块只能属于一个 edit，同一块的替换与补充必须合并成一个 replace edit。',
      inputSchema: documentEditProposalSchema,
      execute: (args) => captureDocumentEdits(ctx, args),
    }),
  }

  for (const definition of AGENT_TOOL_REGISTRY) {
    const runtimeTool = tools[definition.name]
    if (runtimeTool)
      tools[definition.name] = { ...runtimeTool, description: definition.description }
  }

  for (const definition of ctx.externalTools.values()) {
    tools[definition.runtimeName] = tool({
      description: [
        `来自外部 MCP 服务"${definition.serverName}"的工具。`,
        definition.description,
        definition.requiresConfirmation
          ? '该工具调用前需要授权人确认。'
          : definition.serverTrusted
            ? '该服务已被授权人标记为可信，调用由 Runtime 自动批准。'
            : '该工具可在当前策略下直接调用。',
      ]
        .filter(Boolean)
        .join(' '),
      inputSchema: jsonSchema(definition.inputSchema),
      execute: (args) => execute(ctx, definition.runtimeName, args as Record<string, unknown>),
    })
  }

  const activeToolNames = Object.keys(tools).filter((name) => policyAllowsToolName(name, policy))
  const activeToolSet = Object.fromEntries(
    activeToolNames.map((name) => [name, tools[name]]),
  ) as ToolSet

  return { activeToolSet, activeToolNames }
}
