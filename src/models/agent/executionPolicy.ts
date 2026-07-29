export type AgentRiskLevel = 'read_only' | 'propose_write' | 'sensitive'

export interface ExecutionBudget {
  maxInputTokens: number | null
  maxOutputTokens: number
  maxTotalTokens: number | null
  maxCostUsdMicros: number | null
  maxModelTurns: number
  maxParallelTools: number | null
}

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
  /** Phase 0 cumulative-budget protocol. Only output tokens and model turns are enforced in Phase 1. */
  budget?: ExecutionBudget
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
  const tokenBudget = Math.max(1, Math.round(input.tokenBudget))
  return {
    version: 1,
    maxToolRounds: DEFAULT_AGENT_MAX_TOOL_ROUNDS,
    maxDurationMs: DEFAULT_AGENT_MAX_DURATION_MS,
    maxToolFailures: DEFAULT_AGENT_MAX_TOOL_FAILURES,
    tokenBudget,
    allowedTools: Array.from(new Set(input.allowedTools)),
    riskLevel: input.riskLevel ?? 'propose_write',
    allowUserInput: true,
    allowWriteProposals: true,
    maxRetries: DEFAULT_AGENT_MAX_RETRIES,
    budget: {
      maxInputTokens: null,
      maxOutputTokens: tokenBudget,
      maxTotalTokens: null,
      maxCostUsdMicros: null,
      maxModelTurns: DEFAULT_AGENT_MAX_TOOL_ROUNDS,
      maxParallelTools: null,
    },
  }
}

export function normalizeExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  const maxToolRounds = clampInteger(policy.maxToolRounds, 1, 96)
  const tokenBudget = clampInteger(policy.tokenBudget, 1, 128_000)
  return {
    version: 1,
    maxToolRounds,
    maxDurationMs: clampInteger(policy.maxDurationMs, 1_000, 45 * 60 * 1000),
    maxToolFailures: clampInteger(policy.maxToolFailures, 0, 20),
    tokenBudget,
    allowedTools: Array.from(new Set(policy.allowedTools.filter(Boolean))).slice(0, 128),
    riskLevel: ['read_only', 'propose_write', 'sensitive'].includes(policy.riskLevel)
      ? policy.riskLevel
      : 'propose_write',
    allowUserInput: Boolean(policy.allowUserInput),
    allowWriteProposals: Boolean(policy.allowWriteProposals),
    maxRetries: clampInteger(policy.maxRetries, 0, 8),
    budget: normalizeExecutionBudget(policy.budget, { tokenBudget, maxToolRounds }),
  }
}

export function resolveExecutionBudget(policy: ExecutionPolicy): ExecutionBudget {
  return normalizeExecutionBudget(policy.budget, {
    tokenBudget: clampInteger(policy.tokenBudget, 1, 128_000),
    maxToolRounds: clampInteger(policy.maxToolRounds, 1, 96),
  })
}

function normalizeExecutionBudget(
  budget: ExecutionBudget | undefined,
  fallback: { tokenBudget: number; maxToolRounds: number },
): ExecutionBudget {
  return {
    maxInputTokens: clampNullableInteger(budget?.maxInputTokens, 1, 10_000_000),
    maxOutputTokens: clampInteger(budget?.maxOutputTokens ?? fallback.tokenBudget, 1, 128_000),
    maxTotalTokens: clampNullableInteger(budget?.maxTotalTokens, 1, 10_000_000),
    maxCostUsdMicros: clampNullableInteger(budget?.maxCostUsdMicros, 0, 10_000_000_000),
    maxModelTurns: clampInteger(budget?.maxModelTurns ?? fallback.maxToolRounds, 1, 96),
    maxParallelTools: clampNullableInteger(budget?.maxParallelTools, 1, 64),
  }
}

function clampNullableInteger(
  value: number | null | undefined,
  minimum: number,
  maximum: number,
): number | null {
  return value === null || value === undefined ? null : clampInteger(value, minimum, maximum)
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(Math.round(value), maximum))
}
