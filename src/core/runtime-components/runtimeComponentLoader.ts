import { BrowserBlobScriptHost } from '../modules/scriptExecutor'

import type {
  RuntimeComponentDefinition,
  RuntimeComponentId,
} from './contracts'
import type { RuntimeComponentDescriptor } from './runtimeComponentManifest'

let executionTail: Promise<void> = Promise.resolve()

export class RuntimeComponentLoader {
  constructor(private readonly host = new BrowserBlobScriptHost()) {}

  load<I extends RuntimeComponentId>(
    descriptor: RuntimeComponentDescriptor & { id: I },
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<RuntimeComponentDefinition<I>> {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const result = executionTail
      .catch(() => undefined)
      .then(() => this.execute(descriptor, source, signal))
    executionTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async execute<I extends RuntimeComponentId>(
    descriptor: RuntimeComponentDescriptor & { id: I },
    source: string,
    signal?: AbortSignal,
  ): Promise<RuntimeComponentDefinition<I>> {
    if (signal?.aborted) throw new DOMException('Loading aborted', 'AbortError')
    let definition: RuntimeComponentDefinition | undefined
    let registrations = 0
    let registrationOpen = true
    const register = (candidate: RuntimeComponentDefinition): void => {
      if (!registrationOpen) {
        throw new Error('Runtime component registration must be synchronous')
      }
      registrations += 1
      if (registrations > 1) {
        throw new Error('Runtime component registered more than once')
      }
      if (
        !candidate ||
        candidate.id !== descriptor.id ||
        typeof candidate.create !== 'function'
      ) {
        throw new Error(
          'Runtime component definition does not match descriptor',
        )
      }
      definition = candidate
    }
    const removeBridge = this.host.setBridge(
      '__yolo_register_runtime_component__',
      register,
    )
    let url: string | undefined
    let resource: { remove(): void } | undefined
    try {
      url = this.host.createScriptUrl(source)
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void): void => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          callback()
        }
        const onAbort = (): void => {
          resource?.remove()
          finish(() =>
            reject(new DOMException('Loading aborted', 'AbortError')),
          )
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        resource = this.host.appendScript(
          url!,
          () => finish(resolve),
          (error) =>
            finish(() =>
              reject(error instanceof Error ? error : new Error(String(error))),
            ),
        )
        if (signal?.aborted) onAbort()
      })
      registrationOpen = false
      if (registrations !== 1 || !definition) {
        throw new Error('Runtime component must synchronously register once')
      }
      return definition as RuntimeComponentDefinition<I>
    } finally {
      registrationOpen = false
      resource?.remove()
      if (url) this.host.revokeScriptUrl(url)
      removeBridge()
    }
  }
}
