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

function createArtifact(
  releaseRoot = 'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v0.1.0',
) {
  const entryBytes = encode('yolo.registerModule({ id: "learning" })')
  const entrySha256 = hash(entryBytes)
  const file = {
    role: 'entry',
    name: 'entry.js',
    path: 'entry.js',
    byteSize: entryBytes.byteLength,
    sha256: entrySha256,
    url: `${releaseRoot}/entry.js`,
    storage: 'module',
  }
  const manifestBytes = encode(
    `${JSON.stringify({
      schemaVersion: 1,
      id: 'learning',
      version: '0.1.0',
      hostApi: '^1.0.0',
      dataSchemas: { learning: { readMin: 0, readMax: 1, write: 1 } },
      variants: [
        { platform: 'desktop', entry: 'entry.js', files: [file] },
        { platform: 'mobile', entry: 'entry.js', files: [file] },
      ],
    })}\n`,
  )
  return {
    entryBytes,
    manifestBytes,
    descriptor: {
      id: 'learning',
      version: '0.1.0',
      hostApi: '^1.0.0',
      dataSchemas: { learning: { readMin: 0, readMax: 1, write: 1 } },
      platform: 'desktop' as const,
      manifestUrl: `${releaseRoot}/module.json`,
      manifest: {
        byteSize: manifestBytes.byteLength,
        sha256: hash(manifestBytes),
      },
    },
  }
}

function readyPath(
  artifact: ReturnType<typeof createArtifact>,
  platform: 'desktop' | 'mobile' = 'desktop',
): string {
  return `plugin/modules/learning/0.1.0/ready.${platform}.${artifact.descriptor.manifest.sha256}.json`
}

function createInstaller(
  adapter: MemoryAdapter,
  download: (url: string) => Promise<Uint8Array>,
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
    download: (request) => download(request.url),
    subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
  })
}

describe('ModuleArtifactInstaller', () => {
  it('cleans staging and refuses promotion when an install is aborted', async () => {
    const artifact = createArtifact()
    const adapter = new MemoryAdapter()
    let resolveManifest!: (bytes: Uint8Array) => void
    const manifestDownload = new Promise<Uint8Array>((resolve) => {
      resolveManifest = resolve
    })
    const installer = createInstaller(adapter, async (url) =>
      url === artifact.descriptor.manifestUrl
        ? manifestDownload
        : artifact.entryBytes,
    )
    const controller = new AbortController()

    const installing = installer.install(artifact.descriptor, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    resolveManifest(artifact.manifestBytes)

    await expect(installing).rejects.toThrow('aborted')
    expect(adapter.folders.has('plugin/modules/learning/0.1.0')).toBe(false)
    expect(adapter.folders.has('plugin/modules/learning/.staging-0.1.0')).toBe(
      false,
    )
  })

  it('stages, verifies, promotes, and reuses an immutable version', async () => {
    const artifact = createArtifact()
    const adapter = new MemoryAdapter()
    const download = jest.fn(async (url: string) => {
      if (url === artifact.descriptor.manifestUrl) return artifact.manifestBytes
      if (url.endsWith('/entry.js')) return artifact.entryBytes
      throw new Error(`Unexpected download: ${url}`)
    })
    const installer = createInstaller(adapter, download)

    await expect(installer.install(artifact.descriptor)).resolves.toMatchObject(
      {
        id: 'learning',
        version: '0.1.0',
      },
    )
    expect(adapter.files.has(readyPath(artifact))).toBe(true)
    expect(adapter.files.has(readyPath(artifact, 'mobile'))).toBe(true)
    expect(adapter.files.has('plugin/modules/learning/0.1.0/ready.json')).toBe(
      false,
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

  it('installs from a canonical encoded Learning release tag', async () => {
    const artifact = createArtifact(
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv0.1.0',
    )
    const adapter = new MemoryAdapter()
    const download = jest.fn(async (url: string) =>
      url === artifact.descriptor.manifestUrl
        ? artifact.manifestBytes
        : artifact.entryBytes,
    )

    await expect(
      createInstaller(adapter, download).install(artifact.descriptor),
    ).resolves.toMatchObject({ id: 'learning', version: '0.1.0' })
    expect(download).toHaveBeenCalledWith(
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv0.1.0/entry.js',
    )
  })

  it.each(['learning/v0.1.0', 'learning%252Fv0.1.0', 'learning%2F..'])(
    'rejects unsafe descriptor release tag form %s',
    (tag) => {
      const artifact = createArtifact()
      const adapter = new MemoryAdapter()
      const download = jest.fn(async () => artifact.manifestBytes)
      expect(() =>
        createInstaller(adapter, download).install({
          ...artifact.descriptor,
          manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${tag}/module.json`,
        }),
      ).toThrow('descriptor is invalid')
      expect(download).not.toHaveBeenCalled()
    },
  )

  it('removes staging and leaves no ready version after a hash mismatch', async () => {
    const artifact = createArtifact()
    const adapter = new MemoryAdapter()
    const installer = createInstaller(adapter, async (url) =>
      url === artifact.descriptor.manifestUrl
        ? artifact.manifestBytes
        : encode('damaged'),
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
    const validDownload = jest.fn(async (url: string) =>
      url === artifact.descriptor.manifestUrl
        ? artifact.manifestBytes
        : artifact.entryBytes,
    )
    const installer = createInstaller(adapter, validDownload)
    await installer.install(artifact.descriptor)

    const entryPath = 'plugin/modules/learning/0.1.0/entry.js'
    const original = new Uint8Array(await adapter.readBinary(entryPath))
    adapter.failReadOnce = readyPath(artifact)

    await expect(installer.install(artifact.descriptor)).rejects.toThrow(
      'version directory exists but is invalid',
    )
    expect(new Uint8Array(await adapter.readBinary(entryPath))).toEqual(
      original,
    )
    expect(validDownload).toHaveBeenCalledTimes(2)
  })

  it('uses manifest-fixed URLs and rejects descriptor compatibility drift', async () => {
    const artifact = createArtifact()
    const adapter = new MemoryAdapter()
    const requested: string[] = []
    const installer = createInstaller(adapter, async (url) => {
      requested.push(url)
      return url === artifact.descriptor.manifestUrl
        ? artifact.manifestBytes
        : artifact.entryBytes
    })

    await installer.install(artifact.descriptor)
    expect(requested).toEqual([
      artifact.descriptor.manifestUrl,
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v0.1.0/entry.js',
    ])

    const otherAdapter = new MemoryAdapter()
    const mismatched = createInstaller(
      otherAdapter,
      async () => artifact.manifestBytes,
    )
    await expect(
      mismatched.install({ ...artifact.descriptor, hostApi: '^2.0.0' }),
    ).rejects.toThrow('descriptor mismatch')
    expect([...adapter.files.keys()].includes(readyPath(artifact))).toBe(true)
    const ready = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(await adapter.readBinary(readyPath(artifact))),
      ),
    ) as { platform: string }
    expect(ready.platform).toBe('desktop')
  })

  it('installs and verifies the immutable union for both platform variants', async () => {
    const artifact = createArtifact()
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    ) as {
      variants: Array<{
        platform: string
        entry: string
        files: Array<Record<string, unknown>>
      }>
    }
    const mobileBytes = encode('mobile entry')
    manifest.variants[1] = {
      platform: 'mobile',
      entry: 'mobile.js',
      files: [
        {
          role: 'entry',
          name: 'mobile.js',
          path: 'mobile.js',
          byteSize: mobileBytes.byteLength,
          sha256: hash(mobileBytes),
          url: artifact.descriptor.manifestUrl.replace(
            'module.json',
            'mobile.js',
          ),
          storage: 'module',
        },
      ],
    }
    const manifestBytes = encode(`${JSON.stringify(manifest)}\n`)
    const descriptor = {
      ...artifact.descriptor,
      manifest: {
        byteSize: manifestBytes.byteLength,
        sha256: hash(manifestBytes),
      },
    }
    const adapter = new MemoryAdapter()
    const download = jest.fn(async (url: string) => {
      if (url === descriptor.manifestUrl) return manifestBytes
      return url.endsWith('/mobile.js') ? mobileBytes : artifact.entryBytes
    })
    const installer = createInstaller(adapter, download)

    await installer.install(descriptor)
    expect(download).toHaveBeenCalledTimes(3)
    expect(adapter.files.has('plugin/modules/learning/0.1.0/entry.js')).toBe(
      true,
    )
    expect(adapter.files.has('plugin/modules/learning/0.1.0/mobile.js')).toBe(
      true,
    )
    expect(adapter.files.has(readyPath({ ...artifact, descriptor }))).toBe(true)
    expect(
      adapter.files.has(readyPath({ ...artifact, descriptor }, 'mobile')),
    ).toBe(true)

    await installer.install({ ...descriptor, platform: 'mobile' })
    expect(download).toHaveBeenCalledTimes(3)
  })

  it('rejects conflicting duplicate paths across platform variants', async () => {
    const artifact = createArtifact()
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    ) as { variants: Array<{ files: Array<{ sha256: string }> }> }
    manifest.variants[1].files[0].sha256 = 'b'.repeat(64)
    const manifestBytes = encode(`${JSON.stringify(manifest)}\n`)
    const adapter = new MemoryAdapter()
    const download = jest.fn(async () => manifestBytes)

    await expect(
      createInstaller(adapter, download).install({
        ...artifact.descriptor,
        manifest: {
          byteSize: manifestBytes.byteLength,
          sha256: hash(manifestBytes),
        },
      }),
    ).rejects.toThrow('Conflicting module artifact file path')
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-release and device-stored selected files before file download', async () => {
    const artifact = createArtifact()
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    ) as {
      variants: Array<{
        files: Array<{ url: string; storage: 'module' | 'device' }>
      }>
    }
    const installManifest = async (
      mutate: (
        file: (typeof manifest.variants)[number]['files'][number],
      ) => void,
    ) => {
      const changed = structuredClone(manifest)
      for (const variant of changed.variants) mutate(variant.files[0])
      const manifestBytes = encode(`${JSON.stringify(changed)}\n`)
      const descriptor = {
        ...artifact.descriptor,
        manifest: {
          byteSize: manifestBytes.byteLength,
          sha256: hash(manifestBytes),
        },
      }
      const adapter = new MemoryAdapter()
      const download = jest.fn(async () => manifestBytes)
      return {
        adapter,
        download,
        installing: createInstaller(adapter, download).install(descriptor),
      }
    }

    const crossRelease = await installManifest((file) => {
      file.url =
        'https://github.com/Lapis0x0/obsidian-yolo/releases/download/other-tag/entry.js'
    })
    await expect(crossRelease.installing).rejects.toThrow(
      'does not belong to the manifest GitHub Release',
    )
    expect(crossRelease.download).toHaveBeenCalledTimes(1)

    const device = await installManifest((file) => {
      file.storage = 'device'
    })
    await expect(device.installing).rejects.toThrow(
      'Device-stored module artifact "entry.js" is unsupported',
    )
    expect(device.download).toHaveBeenCalledTimes(1)
    expect(
      [...device.adapter.files.keys()].some((path) =>
        path.endsWith('entry.js'),
      ),
    ).toBe(false)
  })
})
