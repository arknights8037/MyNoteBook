import { AgentWorkerHost } from './AgentWorkerHost.js'
import { AiSdkWorkerRuntime } from './AiSdkWorkerRuntime.js'
import { createStdioAgentWorkerChannel } from './StdioAgentWorkerChannel.js'

const channel = createStdioAgentWorkerChannel()
const host = new AgentWorkerHost({
  channel,
  createRuntime: (bridge) => new AiSdkWorkerRuntime(bridge),
  runtimeVersion: 'ai-sdk-worker-v1',
})

host.start()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void host.stop(`received ${signal}`).finally(() => process.exit(0))
  })
}
