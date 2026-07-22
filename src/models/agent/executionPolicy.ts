export type AgentRiskLevel = 'read_only' | 'propose_write' | 'sensitive'

export interface ExecutionPolicy {
  version: 1
  maxToolRounds: number
  maxDurationMs: number
  maxToolFailures: number
  tokenBudget: number
  allowedTools: string[]
  riskLevel: AgentRiskLevel
  allowUserInput: boolean
  allowWriteProposals: boolean
  maxRetries: number
}

export const DEFAULT_AGENT_MAX_TOOL_ROUNDS = 48
export const DEFAULT_AGENT_MAX_TOOL_FAILURES = 10
export const DEFAULT_AGENT_MAX_DURATION_MS = 15 * 60 * 1000
export const DEFAULT_AGENT_MAX_RETRIES = 4

export function createDefaultExecutionPolicy(input: {
  tokenBudget: number
  allowedTools: string[]
  riskLevel?: AgentRiskLevel
}): ExecutionPolicy {
  return {
    version: 1,
    maxToolRounds: DEFAULT_AGENT_MAX_TOOL_ROUNDS,
    maxDurationMs: DEFAULT_AGENT_MAX_DURATION_MS,
    maxToolFailures: DEFAULT_AGENT_MAX_TOOL_FAILURES,
    tokenBudget: Math.max(1, Math.round(input.tokenBudget)),
    allowedTools: Array.from(new Set(input.allowedTools)),
    riskLevel: input.riskLevel ?? 'propose_write',
    allowUserInput: true,
    allowWriteProposals: true,
    maxRetries: DEFAULT_AGENT_MAX_RETRIES,
  }
}

export function normalizeExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  return {
    version: 1,
    maxToolRounds: clampInteger(policy.maxToolRounds, 1, 96),
    maxDurationMs: clampInteger(policy.maxDurationMs, 1_000, 45 * 60 * 1000),
    maxToolFailures: clampInteger(policy.maxToolFailures, 0, 20),
    tokenBudget: clampInteger(policy.tokenBudget, 1, 128_000),
    allowedTools: Array.from(new Set(policy.allowedTools.filter(Boolean))).slice(0, 128),
    riskLevel: ['read_only', 'propose_write', 'sensitive'].includes(policy.riskLevel)
      ? policy.riskLevel
      : 'propose_write',
    allowUserInput: Boolean(policy.allowUserInput),
    allowWriteProposals: Boolean(policy.allowWriteProposals),
    maxRetries: clampInteger(policy.maxRetries, 0, 8),
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(Math.round(value), maximum))
}
