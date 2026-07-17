import { verifyModuleBytes } from './moduleIntegrity'
import type {
  ModuleRegistrationCapture,
  ModuleScriptExecutor,
} from './scriptExecutor'
import type {
  YoloModuleDefinition,
  YoloModuleEntry,
  YoloModuleRuntimeRegistration,
} from './types'

export type ModuleLoaderOptions = {
  executor: ModuleScriptExecutor
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
}

function assertEntry(entry: YoloModuleEntry): void {
  if (!entry.id) throw new Error('Module entry id must not be empty')
  if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0) {
    throw new Error(`Module "${entry.id}" has an invalid entry byte size`)
  }
  if (!/^[a-fA-F0-9]{64}$/.test(entry.sha256)) {
    throw new Error(`Module "${entry.id}" has an invalid SHA-256 digest`)
  }
}

function assertDefinition(
  value: unknown,
): asserts value is YoloModuleDefinition {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Partial<YoloModuleDefinition>).id !== 'string' ||
    !(value as Partial<YoloModuleDefinition>).id ||
    typeof (value as Partial<YoloModuleDefinition>).activate !== 'function'
  ) {
    throw new Error('Module registered an invalid definition')
  }
}

class RegistrationCapture implements ModuleRegistrationCapture {
  readonly definitions: unknown[] = []
  private open = true
  private violation: Error | undefined

  readonly registration: YoloModuleRuntimeRegistration = {
    registerModule: (definition): void => {
      if (!this.open) {
        throw new Error('Module registration must be synchronous')
      }
      this.definitions.push(definition)
      if (this.definitions.length > 1) {
        this.violation = new Error(
          'Module entry registered more than one module',
        )
        throw this.violation
      }
    },
  }

  closeRegistration(): void {
    this.open = false
  }

  result(expectedId: string): YoloModuleDefinition {
    if (this.violation) throw this.violation
    if (this.definitions.length === 0) {
      throw new Error('Module entry did not register a module synchronously')
    }
    const definition = this.definitions[0]
    assertDefinition(definition)
    if (definition.id !== expectedId) {
      throw new Error(
        `Module entry expected id "${expectedId}" but registered "${definition.id}"`,
      )
    }
    return definition
  }
}

/** Integrity-checks and serially evaluates first-party module entries. */
export class ModuleLoader {
  private queue: Promise<void> = Promise.resolve()
  private readonly subtleCrypto: Pick<SubtleCrypto, 'digest'>

  constructor(private readonly options: ModuleLoaderOptions) {
    const subtleCrypto = options.subtleCrypto ?? globalThis.crypto?.subtle
    if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
    this.subtleCrypto = subtleCrypto
  }

  load(
    entry: YoloModuleEntry,
    entryBytes: Uint8Array,
  ): Promise<YoloModuleDefinition> {
    const operation = this.queue.then(() => this.loadOne(entry, entryBytes))
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async loadOne(
    entry: YoloModuleEntry,
    entryBytes: Uint8Array,
  ): Promise<YoloModuleDefinition> {
    assertEntry(entry)
    await verifyModuleBytes(
      entryBytes,
      entry,
      `Module "${entry.id}" entry`,
      this.subtleCrypto,
    )

    const source = new TextDecoder('utf-8', { fatal: true }).decode(entryBytes)
    const capture = new RegistrationCapture()
    try {
      await this.options.executor.execute(source, capture)
    } finally {
      capture.closeRegistration()
    }
    return capture.result(entry.id)
  }
}
