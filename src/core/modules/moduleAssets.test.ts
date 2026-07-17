import { ModuleLifecycleScope } from './lifecycleScope'
import {
  ModuleAssetsCapabilityProvider,
  type ModuleAssetsCapabilityProviderOptions,
} from './moduleAssets'
import type { ModuleArtifactFile, ModuleArtifactManifest } from './moduleStore'

const encoder = new TextEncoder()
const fixtureDigest = (bytes: Uint8Array): Uint8Array => {
  const digest = new Uint8Array(32)
  bytes.forEach((byte, index) => {
    digest[index % digest.length] ^= byte
  })
  return digest
}
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const subtleCrypto: Pick<SubtleCrypto, 'digest'> = {
  digest: async (_algorithm, data) =>
    fixtureDigest(new Uint8Array(data as ArrayBuffer)).buffer,
}

function file(
  role: ModuleArtifactFile['role'],
  path: string,
  content: Uint8Array,
): ModuleArtifactFile {
  return Object.freeze({
    role,
    path,
    byteSize: content.byteLength,
    sha256: toHex(fixtureDigest(content)),
  })
}

function createHarness(
  overrides: {
    readEntryBytes?: ModuleAssetsCapabilityProviderOptions['store']['readEntryBytes']
    createObjectURL?: (blob: Blob) => string
  } = {},
) {
  const contents = {
    'entry.js': encoder.encode('entry'),
    'styles/theme.css': encoder.encode('.root { color: red; }'),
    'workers/index.js': encoder.encode('self.postMessage("ready")'),
    'runtime.wasm': Uint8Array.from([0, 97, 115, 109]),
    'private.dat': encoder.encode('private'),
  }
  const files = [
    file('entry', 'entry.js', contents['entry.js']),
    file('style', 'styles/theme.css', contents['styles/theme.css']),
    file('worker', 'workers/index.js', contents['workers/index.js']),
    file('wasm', 'runtime.wasm', contents['runtime.wasm']),
    file('data', 'private.dat', contents['private.dat']),
  ]
  const manifest: ModuleArtifactManifest = Object.freeze({
    schemaVersion: 1,
    id: 'learning',
    version: '2.1.0',
    hostApi: 1,
    entry: Object.freeze({
      path: files[0].path,
      byteSize: files[0].byteSize,
      sha256: files[0].sha256,
    }),
    files: Object.freeze(files),
  })
  const readEntryBytes =
    overrides.readEntryBytes ??
    jest.fn(async (_moduleId: string, _version: string, path: string) => {
      const bytes = contents[path as keyof typeof contents]
      if (!bytes) throw new Error('missing fixture')
      return bytes
    })
  const blobs: Blob[] = []
  const createObjectURL = jest.fn(
    overrides.createObjectURL ??
      ((blob: Blob) => {
        blobs.push(blob)
        return `blob:test-${blobs.length}`
      }),
  )
  const revokeObjectURL = jest.fn()
  const lifecycle = new ModuleLifecycleScope()
  const provider = new ModuleAssetsCapabilityProvider({
    store: { readEntryBytes },
    getVerifiedArtifact: async () => ({
      manifest,
      entryBytes: contents['entry.js'],
    }),
    urlApi: { createObjectURL, revokeObjectURL },
    subtleCrypto,
  })
  const activation = provider.create('learning', lifecycle)
  activation.activate()
  return {
    activation,
    blobs,
    createObjectURL,
    lifecycle,
    manifest,
    readEntryBytes,
    revokeObjectURL,
  }
}

describe('ModuleAssetsCapabilityProvider', () => {
  it('rejects access before activation commits', async () => {
    const harness = createHarness()
    const lifecycle = new ModuleLifecycleScope()
    const inactive = new ModuleAssetsCapabilityProvider({
      store: { readEntryBytes: harness.readEntryBytes },
      getVerifiedArtifact: () => ({
        manifest: harness.manifest,
        entryBytes: encoder.encode('entry'),
      }),
      subtleCrypto,
    }).create('learning', lifecycle)

    await expect(inactive.api.readText('styles/theme.css')).rejects.toThrow(
      'assets are not active',
    )
    lifecycle.dispose()
  })

  it('reads declared assets from the current installed module version', async () => {
    const harness = createHarness()

    await expect(
      harness.activation.api.readText('styles\\theme.css'),
    ).resolves.toBe('.root { color: red; }')
    await expect(
      harness.activation.api.readText('WORKERS/index.js'),
    ).resolves.toBe('self.postMessage("ready")')
    const wasm = await harness.activation.api.readArrayBuffer('runtime.wasm')

    expect(new Uint8Array(wasm)).toEqual(Uint8Array.from([0, 97, 115, 109]))
    expect(harness.readEntryBytes).toHaveBeenNthCalledWith(
      1,
      'learning',
      '2.1.0',
      'styles/theme.css',
    )
    expect(harness.readEntryBytes).toHaveBeenNthCalledWith(
      2,
      'learning',
      '2.1.0',
      'workers/index.js',
    )
  })

  it.each([
    ['entry.js', 'not declared as style, worker, or wasm'],
    ['private.dat', 'not declared as style, worker, or wasm'],
    ['missing.css', 'not declared as style, worker, or wasm'],
    ['module.json', 'metadata'],
    ['READY.JSON', 'metadata'],
    ['../styles/theme.css', 'relative file path'],
    ['/styles/theme.css', 'relative file path'],
    ['styles/../theme.css', 'relative file path'],
  ])('rejects inaccessible path %s', async (path, message) => {
    const harness = createHarness()

    await expect(harness.activation.api.readArrayBuffer(path)).rejects.toThrow(
      message,
    )
    expect(harness.readEntryBytes).not.toHaveBeenCalled()
  })

  it('rejects decoding wasm as text', async () => {
    const harness = createHarness()

    await expect(
      harness.activation.api.readText('runtime.wasm'),
    ).rejects.toThrow('cannot be read as text')
  })

  it('rejects asset bytes changed after artifact verification', async () => {
    const harness = createHarness({
      readEntryBytes: async () => encoder.encode('tampered'),
    })

    await expect(
      harness.activation.api.createBlobUrl('workers/index.js'),
    ).rejects.toThrow(/size mismatch|SHA-256 mismatch/)
    expect(harness.createObjectURL).not.toHaveBeenCalled()
  })

  it('creates role-typed Blob URLs and revokes all of them on dispose', async () => {
    const harness = createHarness()

    await expect(
      harness.activation.api.createBlobUrl('styles/theme.css'),
    ).resolves.toBe('blob:test-1')
    await expect(
      harness.activation.api.createBlobUrl('runtime.wasm'),
    ).resolves.toBe('blob:test-2')
    expect(harness.blobs.map((blob) => blob.type)).toEqual([
      'text/css;charset=utf-8',
      'application/wasm',
    ])

    harness.lifecycle.dispose()

    expect(harness.revokeObjectURL.mock.calls).toEqual([
      ['blob:test-1'],
      ['blob:test-2'],
    ])
    await expect(
      harness.activation.api.readText('styles/theme.css'),
    ).rejects.toThrow('no longer active')
    await expect(
      harness.activation.api.createBlobUrl('runtime.wasm'),
    ).rejects.toThrow('no longer active')
  })

  it('rejects an in-flight read if disposal wins the race', async () => {
    let finishRead!: (bytes: Uint8Array) => void
    const blocked = new Promise<Uint8Array>((resolve) => {
      finishRead = resolve
    })
    const harness = createHarness({ readEntryBytes: async () => blocked })
    const reading = harness.activation.api.readArrayBuffer('runtime.wasm')
    await Promise.resolve()
    await Promise.resolve()

    harness.lifecycle.dispose()
    finishRead(Uint8Array.from([0, 97, 115, 109]))

    await expect(reading).rejects.toThrow('no longer active')
  })

  it('revokes a URL created reentrantly after disposal', async () => {
    const control: { dispose(): void } = { dispose: () => undefined }
    const harness = createHarness({
      createObjectURL: () => {
        control.dispose()
        return 'blob:late'
      },
    })
    control.dispose = () => harness.lifecycle.dispose()

    await expect(
      harness.activation.api.createBlobUrl('runtime.wasm'),
    ).rejects.toThrow('no longer active')
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:late')
  })

  it('rejects missing and mismatched installed artifacts before store access', async () => {
    const harness = createHarness()
    const missingLifecycle = new ModuleLifecycleScope()
    const missing = new ModuleAssetsCapabilityProvider({
      store: { readEntryBytes: harness.readEntryBytes },
      getVerifiedArtifact: () => undefined,
      subtleCrypto,
    }).create('learning', missingLifecycle)
    const mismatchedActivation = new ModuleAssetsCapabilityProvider({
      store: { readEntryBytes: harness.readEntryBytes },
      getVerifiedArtifact: () => ({
        manifest: { ...harness.manifest, id: 'other' },
        entryBytes: encoder.encode('entry'),
      }),
      subtleCrypto,
    }).create('learning', new ModuleLifecycleScope())
    missing.activate()
    mismatchedActivation.activate()

    await expect(missing.api.readText('styles/theme.css')).rejects.toThrow(
      'no installed artifact',
    )
    await expect(
      mismatchedActivation.api.readText('styles/theme.css'),
    ).rejects.toThrow('identity mismatch')
    expect(harness.readEntryBytes).not.toHaveBeenCalled()
  })
})
