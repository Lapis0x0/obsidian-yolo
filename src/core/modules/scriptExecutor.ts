import type { YoloModuleRuntimeRegistration } from './types'

export type ModuleRegistrationCapture = {
  readonly registration: YoloModuleRuntimeRegistration
  closeRegistration(): void
}

export type ModuleScriptExecutor = {
  execute(source: string, capture: ModuleRegistrationCapture): Promise<void>
}

export type ScriptResource = {
  remove(): void
}

/** Injectable browser operations keep the executor independently testable. */
export type BlobScriptHost = {
  setBridge(name: string, value: unknown): () => void
  createScriptUrl(source: string): string
  appendScript(
    url: string,
    onLoad: () => void,
    onError: (error: unknown) => void,
  ): ScriptResource
  revokeScriptUrl(url: string): void
}

type BridgeGlobal = typeof globalThis & Record<string, unknown>

export class BrowserBlobScriptHost implements BlobScriptHost {
  setBridge(name: string, value: unknown): () => void {
    const target = globalThis as BridgeGlobal
    const hadOwnValue = Object.prototype.hasOwnProperty.call(target, name)
    const previousValue = target[name]
    target[name] = value
    return () => {
      if (hadOwnValue) target[name] = previousValue
      else Reflect.deleteProperty(target, name)
    }
  }

  createScriptUrl(source: string): string {
    return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  }

  appendScript(
    url: string,
    onLoad: () => void,
    onError: (error: unknown) => void,
  ): ScriptResource {
    const script = document.createElement('script')
    script.src = url
    script.onload = onLoad
    script.onerror = onError
    document.head.appendChild(script)
    return script
  }

  revokeScriptUrl(url: string): void {
    URL.revokeObjectURL(url)
  }
}

let nextBridgeId = 0

/** Executes classic scripts from Blob URLs and releases every temporary resource. */
export class DomBlobModuleScriptExecutor implements ModuleScriptExecutor {
  constructor(
    private readonly host: BlobScriptHost = new BrowserBlobScriptHost(),
  ) {}

  async execute(
    source: string,
    capture: ModuleRegistrationCapture,
  ): Promise<void> {
    const bridgeName = `__yolo_module_bridge_${nextBridgeId++}`
    const bridge = {
      registration: capture.registration,
      closeRegistration: (): void => capture.closeRegistration(),
    }
    const wrappedSource = `((bridge) => {\ntry {\n((yolo) => {\n${source}\n})(bridge.registration);\n} finally {\nbridge.closeRegistration();\n}\n})(globalThis[${JSON.stringify(bridgeName)}]);`

    let url: string | undefined
    let script: ScriptResource | undefined
    const removeBridge = this.host.setBridge(bridgeName, bridge)
    try {
      url = this.host.createScriptUrl(wrappedSource)
      await new Promise<void>((resolve, reject) => {
        script = this.host.appendScript(url!, resolve, reject)
      })
    } finally {
      capture.closeRegistration()
      try {
        script?.remove()
      } finally {
        try {
          if (url !== undefined) this.host.revokeScriptUrl(url)
        } finally {
          removeBridge()
        }
      }
    }
  }
}
