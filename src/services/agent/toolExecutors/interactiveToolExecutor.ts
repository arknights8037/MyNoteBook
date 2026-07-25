import type {
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  AgentToolRequest,
} from '@/services/agent/AgentToolExecutor'
import {
  readOptionalString,
  readRequiredString,
  readStringArray,
} from './toolArgumentParsers'

export function executeInteractiveTool(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
  toolName: string,
): Promise<AgentToolExecutionResult> | AgentToolExecutionResult {
  switch (toolName) {
    case 'request_authorizer_input':
      return executeRequestAuthorizerInput(request, context)
    case 'read_skill_file':
      return executeReadSkillFile(request, context)
    default:
      return { ok: false, error: `交互工具 ${toolName} 未识别。` }
  }
}

async function executeRequestAuthorizerInput(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  if (!context.requestAuthorizerInput) {
    return { ok: false, error: '当前界面未提供授权人互动通道。' }
  }
  const question = readRequiredString(request.arguments.question, 'question')
  const contextDescription = readOptionalString(request.arguments.context, 'context')
  const options = readStringArray(request.arguments.options, 'options', 5).filter(Boolean)
  const allowFreeText = request.arguments.allowFreeText !== false || options.length === 0
  return {
    ok: true,
    value: {
      answer: await context.requestAuthorizerInput({
        question,
        context: contextDescription,
        options,
        allowFreeText,
      }),
    },
  }
}

async function executeReadSkillFile(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  if (!context.executeNativeTool) {
    return { ok: false, error: '当前环境未提供技能文件读取器。' }
  }
  const skillId = readRequiredString(request.arguments.skillId, 'skillId')
  const relativePath = readRequiredString(request.arguments.relativePath, 'relativePath')
  return {
    ok: true,
    value: await context.executeNativeTool(
      'read_skill_file',
      { skillId, relativePath },
      request.callId,
      request.signal,
    ),
  }
}
