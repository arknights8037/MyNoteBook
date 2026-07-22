import type { AgentPatchSet, AgentTask } from '@/models/agent/agent'
import type { UseAgentRunOptions } from './types'
import type { AgentRunOutcome } from './agentRunResult'

export async function createPersistedAgentTask(
  task: AgentTask,
  options: Pick<UseAgentRunOptions, 'tasks' | 'patches'>,
): Promise<string | null> {
  options.tasks.value.unshift(task)
  const createdTask = await (await options.patches.getRepository()).createTask(task)
  if (!createdTask.ok) {
    options.tasks.value = options.tasks.value.filter((candidate) => candidate.id !== task.id)
    return createdTask.error.message
  }
  options.patches.pendingTask.value = null
  options.patches.pendingPatchSet.value = null
  options.patches.showModal.value = false
  return null
}

export async function persistAgentRunResult(input: {
  task: AgentTask
  patchSet: AgentPatchSet | null
  outcome: AgentRunOutcome
  patches: UseAgentRunOptions['patches']
}): Promise<void> {
  if (input.patchSet) {
    const repository = await input.patches.getRepository()
    const savedPatchSet = await repository.savePatchSet(input.patchSet)
    if (!savedPatchSet.ok) throw new Error(savedPatchSet.error.message)
    input.task.status = 'waiting_confirmation'
    input.task.currentStep = '等待用户确认修改'
    const updatedTask = await repository.updateTask(input.task)
    if (!updatedTask.ok) throw new Error(updatedTask.error.message)
    input.patches.pendingTask.value = input.task
    input.patches.pendingPatchSet.value = input.patchSet
    input.patches.showModal.value = true
    return
  }
  if (input.outcome !== 'no_change' && input.outcome !== 'blocked') return
  input.task.status = 'completed'
  input.task.currentStep = input.outcome === 'no_change' ? '内容无需修改' : '需要补充信息'
  input.task.completedAt = Date.now()
  const updatedTask = await (await input.patches.getRepository()).updateTask(input.task)
  if (!updatedTask.ok) throw new Error(updatedTask.error.message)
}
