import { Channel, invoke } from '@tauri-apps/api/core'

type AiProxyEvent =
  | {
      event: 'started'
      data: { status: number; headers: Record<string, string> }
    }
  | { event: 'chunk'; data: { body: string } }
  | { event: 'finished' }

export async function proxyAiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (init.signal?.aborted) throw abortError(init.signal)

  const url = requestUrl(input)
  const body = await requestBody(init.body)
  let responseStarted = false
  let streamFinished = false
  let streamController: ReadableStreamDefaultController<Uint8Array>
  let resolveResponse!: (response: Response) => void
  let rejectResponse!: (error: unknown) => void

  const responsePromise = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
    },
    cancel() {
      finishStream()
    },
  })
  const channel = new Channel<AiProxyEvent>()

  const cleanup = () => init.signal?.removeEventListener('abort', handleAbort)
  const fail = (error: unknown) => {
    if (streamFinished) return
    streamFinished = true
    cleanup()
    if (responseStarted) streamController.error(error)
    else rejectResponse(error)
  }
  function finishStream(): void {
    if (streamFinished) return
    streamFinished = true
    cleanup()
    if (responseStarted) streamController.close()
  }
  function handleAbort(): void {
    fail(abortError(init.signal))
  }

  channel.onmessage = (message) => {
    if (streamFinished) return
    if (message.event === 'started') {
      responseStarted = true
      resolveResponse(
        new Response(stream, {
          status: message.data.status,
          headers: message.data.headers,
        }),
      )
      return
    }
    if (message.event === 'chunk') {
      streamController.enqueue(decodeBase64(message.data.body))
      return
    }
    finishStream()
  }

  init.signal?.addEventListener('abort', handleAbort, { once: true })
  void invoke<void>('proxy_ai_request', {
    input: {
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body,
    },
    onEvent: channel,
  }).catch(fail)

  return responsePromise
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

async function requestBody(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body === null || body === undefined) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  return new Response(body).text()
}

function decodeBase64(value: string): Uint8Array {
  const decoded = globalThis.atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

function abortError(signal: AbortSignal | null | undefined): unknown {
  return signal?.reason ?? new DOMException('请求已取消。', 'AbortError')
}
