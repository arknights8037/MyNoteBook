import type { AgentToolCall, DomainToolManifestEntry } from '@mynotebook/agent-runtime-contracts'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { TSchema } from 'typebox'

import { parseDocumentEditProposal, toAgentPatchProposals } from './proposalCapture.js'
import type { PiAgentPatchProposal, PiDocumentEditProposal, PiToolRpcPort } from './types.js'

export interface PiToolAdapterContext {
  runId: string
  workItemId: string
  getTurnId: () => string | null
  createId: () => string
  now: () => number
  rpc: PiToolRpcPort
  callCounts: Map<string, number>
  callsByProviderId: Map<string, AgentToolCall>
  calls: AgentToolCall[]
  auditTasks: Map<string, Promise<void>>
  capturedDocumentEdits: PiDocumentEditProposal[]
  capturedPatches: PiAgentPatchProposal[]
  onCallChanged: (
    call: AgentToolCall,
    phase: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled',
    detail?: unknown,
  ) => Promise<void>
}

export function adaptDomainTools(
  manifest: readonly DomainToolManifestEntry[],
  context: PiToolAdapterContext,
): AgentTool[] {
  return manifest.map((entry) => ({
    name: entry.name,
    label: entry.presentation.label,
    description: entry.description,
    parameters: structuredClone(entry.inputSchema) as TSchema,
    execute: async (providerToolCallId, params, signal, onUpdate) => {
      const args = asRecord(params)
      const call = ensureToolCall(context, entry, providerToolCallId, args)
      await context.auditTasks.get(call.id)
      const count = (context.callCounts.get(entry.name) ?? 0) + 1
      context.callCounts.set(entry.name, count)
      if (count > entry.maxCallsPerRun) {
        return failCall(context, call, `工具 ${entry.name} 超过本次 Run 的调用上限。`)
      }

      try {
        if (entry.name === 'submit_document_edits') {
          if (context.capturedDocumentEdits.length > 0) {
            throw new Error('一个 Run 只能提交一批最终文档修改提案。')
          }
          const proposal = parseDocumentEditProposal(args)
          context.capturedDocumentEdits.push(proposal)
          context.capturedPatches.push(...toAgentPatchProposals(proposal))
          await completeCall(context, call, { accepted: true, summary: proposal.summary })
          return {
            content: [{ type: 'text', text: '文档修改提案已捕获，等待现有 Diff 审阅流程。' }],
            details: { accepted: true, proposal },
          }
        }

        const result = await context.rpc.invoke(
          {
            requestId: context.createId(),
            runId: context.runId,
            turnId: context.getTurnId(),
            internalToolCallId: call.id,
            providerToolCallId,
            toolName: entry.name,
            arguments: args,
            source: entry.source,
          },
          {
            signal,
            onProgress: (progress) => {
              onUpdate?.({
                content: [{ type: 'text', text: progress.message }],
                details: progress.value,
              })
              context.onCallChanged(call, 'progress', progress)
            },
          },
        )
        if (!result.ok || result.isError) {
          const error =
            result.error ||
            (result.isError ? 'MCP 工具返回 isError=true。' : `工具 ${entry.name} 执行失败。`)
          return failCall(context, call, error, result)
        }
        await completeCall(context, call, result.value)
        return {
          content: [{ type: 'text', text: serializeForModel(result.value) }],
          details: {
            value: result.value,
            mcpIsError: false,
            internalToolCallId: call.id,
            providerToolCallId,
          },
        }
      } catch (error) {
        if (call.completedAt !== null) throw error
        const cancelled = signal?.aborted || isAbortError(error)
        const message = error instanceof Error ? error.message : String(error)
        call.status = 'failed'
        call.error = message
        call.completedAt = context.now()
        await context.onCallChanged(call, cancelled ? 'cancelled' : 'failed', { error: message })
        throw error
      }
    },
  }))
}

export function ensureToolCall(
  context: PiToolAdapterContext,
  entry: DomainToolManifestEntry,
  providerToolCallId: string,
  args: Record<string, unknown>,
): AgentToolCall {
  const existing = context.callsByProviderId.get(providerToolCallId)
  if (existing) return existing
  const call: AgentToolCall = {
    id: context.createId(),
    taskId: context.workItemId,
    runId: context.runId,
    turnId: context.getTurnId(),
    providerToolCallId,
    toolName: entry.name,
    argumentsJson: JSON.stringify(args),
    resultJson: null,
    status: 'running',
    startedAt: context.now(),
    completedAt: null,
    error: null,
  }
  context.callsByProviderId.set(providerToolCallId, call)
  context.calls.push(call)
  context.auditTasks.set(call.id, context.onCallChanged(call, 'started'))
  return call
}

async function completeCall(
  context: PiToolAdapterContext,
  call: AgentToolCall,
  value: unknown,
): Promise<void> {
  call.status = 'completed'
  call.resultJson = JSON.stringify(value ?? null)
  call.completedAt = context.now()
  call.error = null
  await context.onCallChanged(call, 'completed', { value })
}

async function failCall(
  context: PiToolAdapterContext,
  call: AgentToolCall,
  message: string,
  details?: unknown,
): Promise<never> {
  call.status = 'failed'
  call.error = message
  call.resultJson = details === undefined ? null : JSON.stringify(details)
  call.completedAt = context.now()
  await context.onCallChanged(call, 'failed', { error: message, details })
  throw new Error(message)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function serializeForModel(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value ?? null)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
