import type { WorkerRuntimePort } from './ports'
import type { AnkiWorkerRequest, AnkiWorkerResponse } from './protocol'
import { startAnkiWorkerRuntime } from './runtime'

type WorkerScope = {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<AnkiWorkerRequest>) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<AnkiWorkerRequest>) => void,
  ): void
  postMessage(message: AnkiWorkerResponse, transfer?: ArrayBuffer[]): void
}

const scope = self as unknown as WorkerScope
const runtime: WorkerRuntimePort<AnkiWorkerRequest, AnkiWorkerResponse> = {
  subscribeMessage(listener) {
    const bridge = (event: MessageEvent<AnkiWorkerRequest>) =>
      listener(event.data)
    scope.addEventListener('message', bridge)
    return () => scope.removeEventListener('message', bridge)
  },
  postMessage(message, transfer) {
    scope.postMessage(message, transfer)
  },
}

startAnkiWorkerRuntime(runtime)
