import type { WorkerFactory, WorkerPort } from '../../anki/worker/ports'

type HostWorkers = YoloModuleHostApiV1['workers']

export const HOST_ANKI_WORKER_METHOD = 'anki.parse'

/** Adapts a direct-message worker source to the Host 1.1 call RPC envelope. */
export const wrapAnkiWorkerSourceForHostRpc = (source: string): string => `
(() => {
  const directMessageListeners = [];
  let directOnMessage = null;
  const nativeAddEventListener = self.addEventListener.bind(self);
  const nativePostMessage = self.postMessage.bind(self);
  self.addEventListener = (type, listener, options) => {
    if (type === 'message') directMessageListeners.push(listener);
    else nativeAddEventListener(type, listener, options);
  };
  Object.defineProperty(self, 'onmessage', {
    configurable: true,
    get: () => directOnMessage,
    set: (listener) => { directOnMessage = listener; },
  });
  const calls = new Map();
  self.postMessage = (message, transfer) => {
    const rpcId = message && calls.get(message.id);
    if (rpcId === undefined) return;
    calls.delete(message.id);
    nativePostMessage({ id: rpcId, result: message }, transfer || []);
  };
  ${source}
  nativeAddEventListener('message', (event) => {
    const envelope = event.data;
    if (!envelope || envelope.method !== ${JSON.stringify(HOST_ANKI_WORKER_METHOD)}) return;
    const request = envelope.payload;
    if (!request || typeof request.id !== 'string') {
      nativePostMessage({ id: envelope.id, error: 'Invalid Anki worker request' });
      return;
    }
    calls.set(request.id, envelope.id);
    const directEvent = new MessageEvent('message', { data: request });
    try {
      if (typeof directOnMessage === 'function') directOnMessage.call(self, directEvent);
      for (const listener of directMessageListeners) {
        if (typeof listener === 'function') listener.call(self, directEvent);
        else listener.handleEvent(directEvent);
      }
    } catch (error) {
      calls.delete(request.id);
      nativePostMessage({
        id: envelope.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
})();
`

export const createHostAnkiWorkerFactory = (
  workers: HostWorkers,
): WorkerFactory => ({
  spawn<TRequest, TResponse>(source: string): WorkerPort<TRequest, TResponse> {
    const worker = workers.create(wrapAnkiWorkerSourceForHostRpc(source))
    const messageListeners = new Set<(message: TResponse) => void>()
    const errorListeners = new Set<(error: Error) => void>()
    let terminated = false

    return {
      subscribeMessage(listener) {
        if (terminated) return () => undefined
        messageListeners.add(listener)
        return () => void messageListeners.delete(listener)
      },
      subscribeError(listener) {
        if (terminated) return () => undefined
        errorListeners.add(listener)
        return () => void errorListeners.delete(listener)
      },
      postMessage(message, transfer) {
        if (terminated) throw new Error('Anki Host worker was terminated')
        void worker
          .call<TResponse>(HOST_ANKI_WORKER_METHOD, message, { transfer })
          .then(
            (response) => {
              if (terminated) return
              for (const listener of [...messageListeners]) listener(response)
            },
            (error: unknown) => {
              if (terminated) return
              const reported =
                error instanceof Error ? error : new Error(String(error))
              for (const listener of [...errorListeners]) listener(reported)
            },
          )
      },
      terminate() {
        if (terminated) return
        terminated = true
        messageListeners.clear()
        errorListeners.clear()
        worker.terminate()
      },
    }
  },
})
