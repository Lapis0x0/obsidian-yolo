import { ServerResponse } from 'http'

export class WebSseHub {
  private connections = new Map<string, Map<string, ServerResponse>>()
  private connectionIdCounter = 0

  add(conversationId: string, res: ServerResponse): () => void {
    const connId = String(++this.connectionIdCounter)
    if (!this.connections.has(conversationId)) {
      this.connections.set(conversationId, new Map())
    }
    this.connections.get(conversationId)!.set(connId, res)

    return () => {
      const conns = this.connections.get(conversationId)
      if (conns) {
        conns.delete(connId)
        if (conns.size === 0) {
          this.connections.delete(conversationId)
        }
      }
    }
  }

  send(conversationId: string, event: string, data: unknown): void {
    const conns = this.connections.get(conversationId)
    if (!conns) return
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of conns.values()) {
      try {
        res.write(payload)
      } catch {
        // Connection may have been closed
      }
    }
  }

  remove(conversationId: string): void {
    this.connections.delete(conversationId)
  }

  disconnectAll(): void {
    this.connections.clear()
  }
}
