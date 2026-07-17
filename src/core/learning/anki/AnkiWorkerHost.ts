// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- This host boundary is intentionally extensible.
export interface AnkiWorkerHandle<TRequest, TResponse> {
  subscribeMessage(listener: (message: TResponse) => void): () => void
  subscribeError(listener: (error: Error) => void): () => void
  postMessage(message: TRequest, transfer: ArrayBuffer[]): void
  terminate(): void
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- This host boundary is intentionally extensible.
export interface AnkiWorkerHost {
  spawn<TRequest, TResponse>(
    source: string,
  ): AnkiWorkerHandle<TRequest, TResponse>
}
