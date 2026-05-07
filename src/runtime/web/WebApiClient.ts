export class WebApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
  ) {
    super(`${method} ${path} failed: ${status}`)
    this.name = 'WebApiError'
  }
}

export class WebApiClient {
  constructor(private readonly baseUrl: string) {}

  async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    })
    if (!res.ok) throw new WebApiError('GET', path, res.status)
    return res.json() as Promise<T>
  }

  async getArrayBuffer(path: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    })
    if (!res.ok) throw new WebApiError('GET', path, res.status)
    return res.arrayBuffer()
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new WebApiError('POST', path, res.status)
    return res.json() as Promise<T>
  }

  async postArrayBuffer<T>(path: string, body: ArrayBuffer): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/octet-stream',
      }),
      body,
    })
    if (!res.ok) throw new WebApiError('POST', path, res.status)
    return res.json() as Promise<T>
  }

  openEventSource(path: string): EventSource {
    return new EventSource(new URL(`${this.baseUrl}${path}`).toString())
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return extra
  }
}
