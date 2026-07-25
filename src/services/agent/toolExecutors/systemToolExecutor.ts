import type {
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  AgentToolRequest,
} from '@/services/agent/AgentToolExecutor'
import {
  readOptionalInteger,
  readRequiredString,
  readStringArray,
} from './toolArgumentParsers'

export function executeSystemTool(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
  toolName: string,
): Promise<AgentToolExecutionResult> | AgentToolExecutionResult {
  switch (toolName) {
    case 'execute_shell':
      return executeShell(request, context)
    case 'inspect_environment_paths':
    case 'get_system_info':
      return executeSimpleNativeTool(request, context, toolName)
    case 'discover_local_tools':
      return executeDiscoverLocalTools(request, context)
    default:
      return { ok: false, error: `系统工具 ${toolName} 未识别。` }
  }
}

async function executeShell(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  if (!context.executeNativeTool) {
    return { ok: false, error: '当前环境未提供本机命令执行器。' }
  }
  const command = readRequiredString(request.arguments.command, 'command')
  const args = readStringArray(request.arguments.args, 'args')
  const timeoutMs = readOptionalInteger(request.arguments.timeoutMs, 'timeoutMs', 1_000, 30_000)
  const maxOutputChars = readOptionalInteger(
    request.arguments.maxOutputChars,
    'maxOutputChars',
    4_096,
    65_536,
  )
  return {
    ok: true,
    value: await context.executeNativeTool(
      'execute_shell',
      {
        command,
        args,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
      },
      request.callId,
      request.signal,
    ),
  }
}

async function executeSimpleNativeTool(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
  toolName: 'inspect_environment_paths' | 'get_system_info',
): Promise<AgentToolExecutionResult> {
  if (!context.executeNativeTool) {
    return { ok: false, error: '当前环境未提供本机信息执行器。' }
  }
  return {
    ok: true,
    value: await context.executeNativeTool(toolName, {}, request.callId, request.signal),
  }
}

async function executeDiscoverLocalTools(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  if (!context.executeNativeTool) {
    return { ok: false, error: '当前环境未提供本机工具发现执行器。' }
  }
  const names = readStringArray(request.arguments.names, 'names', 32)
  return {
    ok: true,
    value: await context.executeNativeTool(
      'discover_local_tools',
      { names },
      request.callId,
      request.signal,
    ),
  }
}
