// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- This module boundary is intentionally extensible.
export interface WorkerPort<TRequest, TResponse> {
  subscribeMessage(listener: (message: TResponse) => void): () => void
  subscribeError(listener: (error: Error) => void): () => void
  postMessage(message: TRequest, transfer: ArrayBuffer[]): void
  terminate(): void
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Host adapters provide the concrete worker implementation.
export interface WorkerFactory {
  spawn<TRequest, TResponse>(source: string): WorkerPort<TRequest, TResponse>
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Worker globals are isolated behind this runtime port.
export interface WorkerRuntimePort<TRequest, TResponse> {
  subscribeMessage(listener: (message: TRequest) => void): () => void
  postMessage(message: TResponse, transfer?: ArrayBuffer[]): void
}
