import type { DataAdapter, Stat } from 'obsidian'

import { RuntimeComponentInstaller } from './runtimeComponentInstaller'
import type { RuntimeComponentDescriptor } from './runtimeComponentManifest'
import { RuntimeComponentStore } from './runtimeComponentStore'

class MemoryAdapter {
  readonly folders = new Set<string>([
    'config',
    'config/plugins',
    'config/plugins/yolo',
  ])
  readonly files = new Map<string, Uint8Array>()

  async exists(path: string): Promise<boolean> {
    return this.folders.has(path) || this.files.has(path)
  }

  async stat(path: string): Promise<Stat | null> {
    if (this.folders.has(path)) {
      return { type: 'folder', ctime: 0, mtime: 0, size: 0 }
    }
    const bytes = this.files.get(path)
    return bytes
      ? { type: 'file', ctime: 0, mtime: 0, size: bytes.byteLength }
      : null
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path)
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = this.files.get(path)
    if (!bytes) throw new Error(`Missing file: ${path}`)
    return bytes.slice().buffer
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(data.slice(0)))
  }

  async rename(from: string, to: string): Promise<void> {
    if (!this.folders.has(from)) throw new Error(`Missing folder: ${from}`)
    this.folders.delete(from)
    this.folders.add(to)
    for (const folder of [...this.folders]) {
      if (!folder.startsWith(`${from}/`)) continue
      this.folders.delete(folder)
      this.folders.add(`${to}${folder.slice(from.length)}`)
    }
    for (const [path, bytes] of [...this.files]) {
      if (!path.startsWith(`${from}/`)) continue
      this.files.delete(path)
      this.files.set(`${to}${path.slice(from.length)}`, bytes)
    }
  }

  async rmdir(path: string): Promise<void> {
    this.folders.delete(path)
    for (const folder of [...this.folders]) {
      if (folder.startsWith(`${path}/`)) this.folders.delete(folder)
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(`${path}/`)) this.files.delete(file)
    }
  }
}

class FlakyRenameAdapter extends MemoryAdapter {
  targetPath = ''
  failOnTargetRenameCount = -1
  private targetRenameCalls = 0

  async rename(from: string, to: string): Promise<void> {
    if (to === this.targetPath) {
      this.targetRenameCalls += 1
      if (this.targetRenameCalls === this.failOnTargetRenameCount) {
        throw new Error('Simulated rename failure')
      }
    }
    await super.rename(from, to)
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)),
  )
}

describe('RuntimeComponentInstaller', () => {
  it('deduplicates installs and repairs a corrupt promoted target', async () => {
    const bytes = new TextEncoder().encode('trusted component entry')
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', bytes),
    )
    const descriptor: RuntimeComponentDescriptor = {
      id: 'tokenizer',
      platforms: ['desktop', 'mobile'],
      nameKey: 'name',
      descriptionKey: 'description',
      impactKey: 'impact',
      entry: 'runtime-components/tokenizer/dist/entry.js',
      byteSize: bytes.byteLength,
      sha256: [...digest]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join(''),
    }
    const adapter = new MemoryAdapter()
    const store = new RuntimeComponentStore(
      adapter as unknown as DataAdapter,
      { id: 'yolo', dir: 'config/plugins/yolo' },
      'config',
    )
    const download = jest.fn(async () => bytes.slice())
    const installer = new RuntimeComponentInstaller({
      store,
      download,
      subtleCrypto: globalThis.crypto.subtle,
    })

    await Promise.all([
      installer.ensure(descriptor),
      installer.ensure(descriptor),
    ])
    expect(download).toHaveBeenCalledTimes(1)
    await expect(installer.verifyInstalled(descriptor)).resolves.toBeUndefined()

    const staleStaging = `${store.componentRoot(descriptor)}/.staging-${descriptor.sha256}`
    adapter.folders.add(staleStaging)
    adapter.files.set(`${staleStaging}/entry.js`, bytes.slice())
    await installer.ensure(descriptor)
    expect(adapter.folders.has(staleStaging)).toBe(false)
    expect(download).toHaveBeenCalledTimes(1)

    adapter.files.set(
      store.entryPath(descriptor),
      new Uint8Array(descriptor.byteSize).fill(1),
    )
    await installer.ensure(descriptor)
    expect(download).toHaveBeenCalledTimes(2)
    await expect(installer.verifyInstalled(descriptor)).resolves.toBeUndefined()
    expect([...adapter.folders].some((path) => path.includes('.repair-'))).toBe(
      false,
    )
  })

  it('falls back when a preferred source fails integrity verification', async () => {
    const bytes = new TextEncoder().encode('trusted component entry')
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', bytes),
    )
    const descriptor: RuntimeComponentDescriptor = {
      id: 'tokenizer',
      platforms: ['desktop', 'mobile'],
      nameKey: 'name',
      descriptionKey: 'description',
      impactKey: 'impact',
      entry: 'runtime-components/tokenizer/dist/entry.js',
      byteSize: bytes.byteLength,
      sha256: [...digest]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join(''),
    }
    const adapter = new MemoryAdapter()
    const store = new RuntimeComponentStore(
      adapter as unknown as DataAdapter,
      { id: 'yolo', dir: 'config/plugins/yolo' },
      'config',
    )
    const sources = [
      'https://updates.example/entry.js',
      'https://raw.example/entry.js',
    ]
    const download = jest.fn(async ({ source }: { source: string }) =>
      source === sources[0]
        ? new Uint8Array(descriptor.byteSize).fill(1)
        : bytes.slice(),
    )
    const installer = new RuntimeComponentInstaller({
      store,
      download,
      resolveDownloadSources: () => sources,
      subtleCrypto: globalThis.crypto.subtle,
    })

    await installer.ensure(descriptor)

    expect(download.mock.calls.map(([request]) => request.source)).toEqual(
      sources,
    )
    await expect(installer.verifyInstalled(descriptor)).resolves.toBeUndefined()
  })

  it('installs, repairs, and reads back declared assets alongside entry.js', async () => {
    const entryBytes = new TextEncoder().encode('trusted component entry')
    const assetBytes = new TextEncoder().encode('fake wasm bytes')
    const entryDigest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', entryBytes),
    )
    const assetDigest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', assetBytes),
    )
    const toHex = (bytes: Uint8Array) =>
      [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
    const descriptor: RuntimeComponentDescriptor = {
      id: 'embedding-engine',
      platforms: ['desktop'],
      nameKey: 'name',
      descriptionKey: 'description',
      impactKey: 'impact',
      entry: 'runtime-components/embedding-engine/dist/entry.js',
      byteSize: entryBytes.byteLength,
      sha256: toHex(entryDigest),
      assets: [
        {
          name: 'ort-wasm-simd-threaded.wasm',
          path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
          byteSize: assetBytes.byteLength,
          sha256: toHex(assetDigest),
        },
      ],
    }
    const adapter = new MemoryAdapter()
    const store = new RuntimeComponentStore(
      adapter as unknown as DataAdapter,
      { id: 'yolo', dir: 'config/plugins/yolo' },
      'config',
    )
    const download = jest.fn(async ({ asset }: { asset?: { name: string } }) =>
      asset ? assetBytes.slice() : entryBytes.slice(),
    )
    const installer = new RuntimeComponentInstaller({
      store,
      download,
      subtleCrypto: globalThis.crypto.subtle,
    })

    await installer.ensure(descriptor)
    expect(download).toHaveBeenCalledTimes(2)
    await expect(installer.verifyInstalled(descriptor)).resolves.toBeUndefined()
    await expect(
      store.readAsset(descriptor, descriptor.assets![0]),
    ).resolves.toEqual(assetBytes)

    // Corrupt just the asset; verifyInstalled/repair must catch and fix it
    // without needing the entry.js to be damaged too.
    await adapter.writeBinary(
      store.assetPath(descriptor, descriptor.assets![0]),
      new Uint8Array(assetBytes.byteLength).fill(9).buffer,
    )
    await expect(installer.verifyInstalled(descriptor)).rejects.toThrow()
    await installer.ensure(descriptor)
    expect(download).toHaveBeenCalledTimes(4)
    await expect(installer.verifyInstalled(descriptor)).resolves.toBeUndefined()
  })

  it('leaves no target and no staging behind when the second asset fails to install', async () => {
    const entryBytes = new TextEncoder().encode('entry bytes')
    const firstAssetBytes = new TextEncoder().encode('first asset bytes')
    const descriptor: RuntimeComponentDescriptor = {
      id: 'embedding-engine',
      platforms: ['desktop'],
      nameKey: 'name',
      descriptionKey: 'description',
      impactKey: 'impact',
      entry: 'runtime-components/embedding-engine/dist/entry.js',
      byteSize: entryBytes.byteLength,
      sha256: await sha256(entryBytes),
      assets: [
        {
          name: 'first.wasm',
          path: 'runtime-components/embedding-engine/dist/assets/first.wasm',
          byteSize: firstAssetBytes.byteLength,
          sha256: await sha256(firstAssetBytes),
        },
        {
          name: 'second.wasm',
          path: 'runtime-components/embedding-engine/dist/assets/second.wasm',
          byteSize: 8,
          sha256: 'f'.repeat(64),
        },
      ],
    }
    const adapter = new MemoryAdapter()
    const store = new RuntimeComponentStore(
      adapter as unknown as DataAdapter,
      { id: 'yolo', dir: 'config/plugins/yolo' },
      'config',
    )
    const download = jest.fn(
      async ({ asset }: { asset?: { name: string } }) => {
        if (!asset) return entryBytes.slice()
        if (asset.name === 'first.wasm') return firstAssetBytes.slice()
        throw new Error('second asset is permanently unavailable')
      },
    )
    const installer = new RuntimeComponentInstaller({
      store,
      download,
      subtleCrypto: globalThis.crypto.subtle,
    })

    await expect(installer.ensure(descriptor)).rejects.toThrow()

    expect(await adapter.exists(store.targetDir(descriptor))).toBe(false)
    const leftoverStaging = [...adapter.folders].filter(
      (path) =>
        path.startsWith(store.componentRoot(descriptor)) &&
        path.includes('.staging-'),
    )
    expect(leftoverStaging).toEqual([])
  })

  it('restores the previous target when a repair fails after backing it up', async () => {
    const goodEntryBytes = new TextEncoder().encode('good entry bytes')
    const descriptor: RuntimeComponentDescriptor = {
      id: 'tokenizer',
      platforms: ['desktop', 'mobile'],
      nameKey: 'name',
      descriptionKey: 'description',
      impactKey: 'impact',
      entry: 'runtime-components/tokenizer/dist/entry.js',
      byteSize: goodEntryBytes.byteLength,
      sha256: await sha256(goodEntryBytes),
    }
    const adapter = new FlakyRenameAdapter()
    const store = new RuntimeComponentStore(
      adapter as unknown as DataAdapter,
      { id: 'yolo', dir: 'config/plugins/yolo' },
      'config',
    )
    adapter.targetPath = store.targetDir(descriptor)
    const download = jest.fn(async () => goodEntryBytes.slice())
    const installer = new RuntimeComponentInstaller({
      store,
      download,
      subtleCrypto: globalThis.crypto.subtle,
    })

    // A normal, successful install — this is the first rename to
    // `targetPath` and must succeed so there is a "previous target" to
    // restore.
    await installer.ensure(descriptor)
    await expect(installer.verifyInstalled(descriptor)).resolves.toBeUndefined()

    // Corrupt it on disk so the next `ensure()` takes the repair path.
    await adapter.writeBinary(
      store.entryPath(descriptor),
      new Uint8Array(goodEntryBytes.byteLength).fill(9).buffer,
    )
    // The repair's own promotion rename (the *second* rename targeting
    // `targetPath`) fails after the old target has already been backed up.
    adapter.failOnTargetRenameCount = 2

    await expect(installer.ensure(descriptor)).rejects.toThrow(
      'Simulated rename failure',
    )

    // The target directory must exist again (rolled back from the backup),
    // not be left missing or half-written.
    expect(await adapter.exists(store.targetDir(descriptor))).toBe(true)
    const restored = new Uint8Array(
      await adapter.readBinary(store.entryPath(descriptor)),
    )
    expect(restored.every((byte) => byte === 9)).toBe(true)
    const leftovers = [...adapter.folders].filter(
      (path) =>
        path.startsWith(store.componentRoot(descriptor)) &&
        (path.includes('.repair-staging-') || path.includes('.repair-backup-')),
    )
    expect(leftovers).toEqual([])
  })

  it('repairs an old install that has entry.js but is missing a newly declared asset', async () => {
    const entryBytes = new TextEncoder().encode('entry bytes')
    const assetBytes = new TextEncoder().encode('asset bytes')
    const descriptor: RuntimeComponentDescriptor = {
      id: 'embedding-engine',
      platforms: ['desktop'],
      nameKey: 'name',
      descriptionKey: 'description',
      impactKey: 'impact',
      entry: 'runtime-components/embedding-engine/dist/entry.js',
      byteSize: entryBytes.byteLength,
      sha256: await sha256(entryBytes),
      assets: [
        {
          name: 'model.wasm',
          path: 'runtime-components/embedding-engine/dist/assets/model.wasm',
          byteSize: assetBytes.byteLength,
          sha256: await sha256(assetBytes),
        },
      ],
    }
    const adapter = new MemoryAdapter()
    const store = new RuntimeComponentStore(
      adapter as unknown as DataAdapter,
      { id: 'yolo', dir: 'config/plugins/yolo' },
      'config',
    )
    // Simulate a pre-P0 install on disk: the target dir + entry.js already
    // exist (correct bytes), but there is no `assets/` subdirectory at all
    // — as if this component had no assets when it was first installed.
    adapter.folders.add(store.targetDir(descriptor))
    adapter.files.set(store.entryPath(descriptor), entryBytes.slice())

    const download = jest.fn(async ({ asset }: { asset?: { name: string } }) =>
      asset ? assetBytes.slice() : entryBytes.slice(),
    )
    const installer = new RuntimeComponentInstaller({
      store,
      download,
      subtleCrypto: globalThis.crypto.subtle,
    })

    await expect(installer.verifyInstalled(descriptor)).rejects.toThrow()
    await installer.ensure(descriptor)
    await expect(installer.verifyInstalled(descriptor)).resolves.toBeUndefined()
    await expect(
      store.readAsset(descriptor, descriptor.assets![0]),
    ).resolves.toEqual(assetBytes)
  })

  it('falls back to a mirror source for an asset when the preferred source is corrupt', async () => {
    const entryBytes = new TextEncoder().encode('entry bytes')
    const assetBytes = new TextEncoder().encode('asset bytes')
    const descriptor: RuntimeComponentDescriptor = {
      id: 'embedding-engine',
      platforms: ['desktop'],
      nameKey: 'name',
      descriptionKey: 'description',
      impactKey: 'impact',
      entry: 'runtime-components/embedding-engine/dist/entry.js',
      byteSize: entryBytes.byteLength,
      sha256: await sha256(entryBytes),
      assets: [
        {
          name: 'model.wasm',
          path: 'runtime-components/embedding-engine/dist/assets/model.wasm',
          byteSize: assetBytes.byteLength,
          sha256: await sha256(assetBytes),
        },
      ],
    }
    const adapter = new MemoryAdapter()
    const store = new RuntimeComponentStore(
      adapter as unknown as DataAdapter,
      { id: 'yolo', dir: 'config/plugins/yolo' },
      'config',
    )
    const assetSources = [
      'https://updates.example/model.wasm',
      'https://raw.example/model.wasm',
    ]
    const download = jest.fn(
      async ({
        asset,
        source,
      }: {
        asset?: { name: string }
        source: string
      }) => {
        if (!asset) return entryBytes.slice()
        // The preferred (mirror) source is corrupt; only the fallback
        // (Git Raw) source serves the real bytes.
        return source === assetSources[0]
          ? new Uint8Array(assetBytes.byteLength).fill(1)
          : assetBytes.slice()
      },
    )
    const installer = new RuntimeComponentInstaller({
      store,
      download,
      resolveDownloadSources: (targetDescriptor, asset) =>
        asset ? assetSources : [targetDescriptor.entry],
      subtleCrypto: globalThis.crypto.subtle,
    })

    await installer.ensure(descriptor)

    const assetCalls = download.mock.calls.filter(([request]) => request.asset)
    expect(assetCalls.map(([request]) => request.source)).toEqual(assetSources)
    await expect(installer.verifyInstalled(descriptor)).resolves.toBeUndefined()
  })
})
