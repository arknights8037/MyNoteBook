/* global process */

import { readFile, writeFile } from 'node:fs/promises'

const [inputPath, outputPath, submissionType] = process.argv.slice(2)
if (!inputPath || !outputPath || !['result', 'change_set'].includes(submissionType)) {
  throw new Error('usage: cli-agent.mjs <input> <output> <result|change_set>')
}

const envelope = JSON.parse(await readFile(inputPath, 'utf8'))
if (
  envelope.version !== 1 ||
  envelope.taskRun?.id !== 'cli-smoke-run' ||
  envelope.contextBundle?.snapshotHash !== 'cli-smoke-context-hash' ||
  !envelope.delegation?.id
) {
  throw new Error('invalid delegation envelope')
}

const submission =
  submissionType === 'result'
    ? {
        type: 'result',
        entityId: 'cli-smoke-result',
        output: { summary: 'real child process completed' },
      }
    : {
        type: 'change_set',
        entityId: 'cli-smoke-change-set',
        title: 'CLI smoke change set',
        description: 'Must pass verifier and approval before any write.',
      }

await writeFile(
  outputPath,
  JSON.stringify({
    version: 1,
    delegationId: envelope.delegation.id,
    idempotencyKey: `cli-smoke-${submissionType}`,
    submission,
  }),
  'utf8',
)
