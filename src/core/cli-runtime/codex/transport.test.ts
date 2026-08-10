import type { CodexProcessExitListener, CodexProcessLike } from './process'
import { CodexRpcTransport } from './transport'

class FakeProcess implements CodexProcessLike {
  writes: string[] = []
  private lineListener: ((line: string) => void) | null = null

  write(line: string): void {
    this.writes.push(line)
  }
  onLine(listener: (line: string) => void): () => void {
    this.lineListener = listener
    return () => {
      this.lineListener = null
    }
  }
  onExit(_listener: CodexProcessExitListener): () => void {
    return () => undefined
  }
  getStderrSnapshot(): string {
    return ''
  }
  async shutdown(): Promise<void> {}
  emit(message: unknown): void {
    this.lineListener?.(JSON.stringify(message))
  }
}

describe('CodexRpcTransport', () => {
  it('routes responses, notifications, and server requests independently', async () => {
    const process = new FakeProcess()
    const transport = new CodexRpcTransport(process)
    const notifications: string[] = []
    const requests: string[] = []
    transport.onNotification((notification) =>
      notifications.push(notification.method),
    )
    transport.onServerRequest((request) => requests.push(request.method))

    const resultPromise = transport.request<{ ok: boolean }>('thread/list', {})
    const sent = JSON.parse(process.writes[0]) as { id: number }
    process.emit({ jsonrpc: '2.0', method: 'turn/started', params: {} })
    process.emit({
      jsonrpc: '2.0',
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {},
    })
    process.emit({ jsonrpc: '2.0', id: sent.id, result: { ok: true } })

    await expect(resultPromise).resolves.toEqual({ ok: true })
    expect(notifications).toEqual(['turn/started'])
    expect(requests).toEqual(['item/commandExecution/requestApproval'])
  })

  it('buffers notifications that arrive before the matching response', async () => {
    const process = new FakeProcess()
    const transport = new CodexRpcTransport(process)
    const order: string[] = []
    transport.onNotification(() => order.push('notification'))

    const resultPromise = transport
      .request('turn/start', {})
      .then(() => order.push('response'))
    const sent = JSON.parse(process.writes[0]) as { id: number }
    process.emit({ jsonrpc: '2.0', method: 'turn/started', params: {} })
    process.emit({ jsonrpc: '2.0', id: sent.id, result: {} })
    await resultPromise

    expect(order).toEqual(['notification', 'response'])
  })
})
