// eslint-disable-next-line import/no-nodejs-modules -- installer integrity tests use Node's Web Crypto implementation
import { createHash, webcrypto } from 'node:crypto'

import type { DataAdapter } from 'obsidian'

import { ModuleArtifactInstaller } from './moduleArtifactInstaller'
import { ModuleStore } from './moduleStore'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
const hash = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

class MemoryAdapter {
  readonly files = new Map<string, ArrayBuffer>()
  readonly folders = new Set<string>()
  failReadOnce: string | null = null

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      this.folders.add(current)
    }
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    if (this.failReadOnce === path) {
      this.failReadOnce = null
      throw new Error(`Transient read failure: ${path}`)
    }
    const value = this.files.get(path)
    if (!value) throw new Error(`Missing file: ${path}`)
    return value.slice(0)
  }

  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.files.set(path, value.slice(0))
    const parent = path.slice(0, path.lastIndexOf('/'))
    if (parent) await this.mkdir(parent)
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    if (!this.folders.has(path)) throw new Error(`Missing folder: ${path}`)
    const prefix = `${path}/`
    if (
      !recursive &&
      ([...this.files.keys()].some((file) => file.startsWith(prefix)) ||
        [...this.folders].some(
          (folder) => folder !== path && folder.startsWith(prefix),
        ))
    ) {
      throw new Error(`Folder is not empty: ${path}`)
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(prefix)) this.files.delete(file)
    }
    for (const folder of [...this.folders]) {
      if (folder === path || folder.startsWith(prefix)) {
        this.folders.delete(folder)
      }
    }
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`
    return {
      files: [...this.files.keys()].filter(
        (file) =>
          file.startsWith(prefix) && !file.slice(prefix.length).includes('/'),
      ),
      folders: [...this.folders].filter(
        (folder) =>
          folder.startsWith(prefix) &&
          folder !== path &&
          !folder.slice(prefix.length).includes('/'),
      ),
    }
  }

  async rename(from: string, to: string): Promise<void> {
    if (!this.folders.has(from)) throw new Error(`Missing folder: ${from}`)
    const prefix = `${from}/`
    const folderEntries = [...this.folders].filter(
      (folder) => folder === from || folder.startsWith(prefix),
    )
    const fileEntries = [...this.files].filter(([file]) =>
      file.startsWith(prefix),
    )
    for (const folder of folderEntries) this.folders.delete(folder)
    for (const [file] of fileEntries) this.files.delete(file)
    for (const folder of folderEntries) {
      this.folders.add(`${to}${folder.slice(from.length)}`)
    }
    for (const [file, value] of fileEntries) {
      this.files.set(`${to}${file.slice(from.length)}`, value)
    }
  }
}

function createArtifact() {
  const entryBytes = encode('yolo.registerModule({ id: "learning" })')
  const entrySha256 = hash(entryBytes)
  const manifestBytes = encode(
    `${JSON.stringify({
      schemaVersion: 1,
      id: 'learning',
      version: '0.1.0',
      hostApi: 1,
      entry: {
        path: 'entry.js',
        byteSize: entryBytes.byteLength,
        sha256: entrySha256,
      },
      files: [
        {
          role: 'entry',
          path: 'entry.js',
          byteSize: entryBytes.byteLength,
          sha256: entrySha256,
        },
      ],
    })}\n`,
  )
  return {
    entryBytes,
    manifestBytes,
    descriptor: {
      id: 'learning',
      version: '0.1.0',
      manifest: {
        byteSize: manifestBytes.byteLength,
        sha256: hash(manifestBytes),
      },
    },
  }
}

function createInstaller(
  adapter: MemoryAdapter,
  download: (path: string) => Promise<Uint8Array>,
) {
  const dataAdapter = adapter as unknown as DataAdapter
  const store = new ModuleStore({
    adapter: dataAdapter,
    manifest: { id: 'yolo', dir: 'plugin' },
    configDir: '.config',
  })
  return new ModuleArtifactInstaller({
    adapter: dataAdapter,
    store,
    download: (request) => download(request.path),
    subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
  })
}

describe('ModuleArtifactInstaller', () => {
  it('stages, verifies, promotes, and reuses an immutable version', async () => {
    const artifact = createArtifact()
    const adapter = new MemoryAdapter()
    const download = jest.fn(async (path: string) => {
      if (path === 'module.json') return artifact.manifestBytes
      if (path === 'entry.js') return artifact.entryBytes
      throw new Error(`Unexpected download: ${path}`)
    })
    const installer = createInstaller(adapter, download)

    await expect(installer.install(artifact.descriptor)).resolves.toMatchObject(
      {
        id: 'learning',
        version: '0.1.0',
      },
    )
    expect(adapter.files.has('plugin/modules/learning/0.1.0/ready.json')).toBe(
      true,
    )
    expect(adapter.files.has('plugin/modules/learning/0.1.0/entry.js')).toBe(
      true,
    )
    expect(adapter.folders.has('plugin/modules/learning/.staging-0.1.0')).toBe(
      false,
    )

    await installer.install(artifact.descriptor)
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('removes staging and leaves no ready version after a hash mismatch', async () => {
    const artifact = createArtifact()
    const adapter = new MemoryAdapter()
    const installer = createInstaller(adapter, async (path) =>
      path === 'module.json' ? artifact.manifestBytes : encode('damaged'),
    )

    await expect(installer.install(artifact.descriptor)).rejects.toThrow(
      'mismatch',
    )
    expect(adapter.folders.has('plugin/modules/learning/0.1.0')).toBe(false)
    expect(adapter.folders.has('plugin/modules/learning/.staging-0.1.0')).toBe(
      false,
    )
  })

  it('never replaces an immutable version after a transient read failure', async () => {
    const artifact = createArtifact()
    const adapter = new MemoryAdapter()
    const validDownload = jest.fn(async (path: string) =>
      path === 'module.json' ? artifact.manifestBytes : artifact.entryBytes,
    )
    const installer = createInstaller(adapter, validDownload)
    await installer.install(artifact.descriptor)

    const entryPath = 'plugin/modules/learning/0.1.0/entry.js'
    const original = new Uint8Array(await adapter.readBinary(entryPath))
    adapter.failReadOnce = 'plugin/modules/learning/0.1.0/ready.json'

    await expect(installer.install(artifact.descriptor)).rejects.toThrow(
      'version directory exists but is invalid',
    )
    expect(new Uint8Array(await adapter.readBinary(entryPath))).toEqual(
      original,
    )
    expect(validDownload).toHaveBeenCalledTimes(2)
  })
})
