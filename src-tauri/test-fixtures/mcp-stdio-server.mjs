/* global process */

import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const line of lines) {
  if (!line.trim()) continue
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'mynotebook-test-mcp', version: '1.0.0' },
    })
  } else if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo a value.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
          annotations: { readOnlyHint: true },
        },
      ],
    })
  } else if (message.method === 'tools/call') {
    respond(message.id, {
      content: [{ type: 'text', text: `echo:${message.params?.arguments?.value ?? ''}` }],
      isError: false,
    })
  } else if (message.method === 'resources/list') {
    respond(message.id, { resources: [{ uri: 'fixture://rules', name: 'rules', mimeType: 'application/json' }] })
  } else if (message.method === 'resources/read') {
    respond(message.id, { contents: [{ uri: message.params?.uri, mimeType: 'application/json', text: '[{"id":"rule-1"}]' }] })
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not found' } })}\n`)
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
