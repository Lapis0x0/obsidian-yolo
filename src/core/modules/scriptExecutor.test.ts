import {
  type BlobScriptHost,
  DomBlobModuleScriptExecutor,
  type ModuleRegistrationCapture,
  type ScriptResource,
} from './scriptExecutor'
import type { YoloModuleRuntimeRegistration } from './types'

class FakeHost implements BlobScriptHost {
  bridgeName = ''
  bridge: unknown
  removed = 0
  revoked: string[] = []
  deleted: string[] = []
  appendError: unknown

  setBridge(name: string, value: unknown): () => void {
    this.bridgeName = name
    this.bridge = value
    return () => this.deleted.push(name)
  }
  createScriptUrl(): string {
    return 'blob:test'
  }
  appendScript(
    _url: string,
    onLoad: () => void,
    onError: (error: unknown) => void,
  ): ScriptResource {
    if (this.appendError) onError(this.appendError)
    else onLoad()
    return { remove: () => (this.removed += 1) }
  }
  revokeScriptUrl(url: string): void {
    this.revoked.push(url)
  }
}

function capture(): ModuleRegistrationCapture & { closed: number } {
  return {
    closed: 0,
    registration: {
      registerModule: () => undefined,
    } satisfies YoloModuleRuntimeRegistration,
    closeRegistration() {
      this.closed += 1
    },
  }
}

describe('DomBlobModuleScriptExecutor', () => {
  it.each([false, true])(
    'removes the script, revokes the URL, and deletes the bridge (error=%s)',
    async (fails) => {
      const host = new FakeHost()
      if (fails) host.appendError = new Error('script failed')
      const registration = capture()
      const execution = new DomBlobModuleScriptExecutor(host).execute(
        'yolo.registerModule(module)',
        registration,
      )

      if (fails) await expect(execution).rejects.toThrow('script failed')
      else await expect(execution).resolves.toBeUndefined()
      expect(host.removed).toBe(1)
      expect(host.revoked).toEqual(['blob:test'])
      expect(host.deleted).toEqual([host.bridgeName])
      expect(registration.closed).toBeGreaterThan(0)
    },
  )
})
