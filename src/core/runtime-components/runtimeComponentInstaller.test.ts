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
})
