import { invoke } from '@tauri-apps/api/core'

export function throwIfAgentToolAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw createAgentToolAbortError(signal)
}

export async function runCancellableAgentInvoke<T>(
  callId: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfAgentToolAborted(signal)
  const cancel = () => {
    void invoke('cancel_agent_tool_call', { input: { callId } }).catch(() => undefined)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const value = await operation()
    throwIfAgentToolAborted(signal)
    return value
  } catch (error) {
    if (signal?.aborted) throw createAgentToolAbortError(signal)
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

function createAgentToolAbortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  return Object.assign(new Error('Agent 工具调用已取消。'), { name: 'AbortError' })
}
