import type { DataAdapter } from 'obsidian'

import {
  MAX_MODULE_ARTIFACT_FILE_BYTES,
  ModuleStore,
  parseModuleArtifactManifest,
  resolveModulePluginDir,
  selectModuleManifestVariant,
} from './moduleStore'

const releaseUrl = (name: string): string =>
  `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v1.0.0/${name}`

function artifactFile(
  overrides: Partial<{
    role: 'entry' | 'style' | 'worker' | 'wasm' | 'model' | 'data'
    name: string
    path: string
    byteSize: number
    sha256: string
    url: string
    storage: 'module' | 'device'
  }> = {},
) {
  const name = overrides.name ?? 'entry.js'
  return {
    role: 'entry' as const,
    name,
    path: 'entry.js',
    byteSize: 3,
    sha256: 'a'.repeat(64),
    url: releaseUrl(name),
    storage: 'module' as const,
    ...overrides,
  }
}

function artifactManifest(overrides: Record<string, unknown> = {}) {
  const entry = artifactFile()
  return {
    schemaVersion: 1,
    id: 'learning',
    version: '1.0.0',
    hostApi: '^1.0.0',
    dataSchemas: { learning: { readMin: 0, readMax: 2, write: 2 } },
    variants: [{ platform: 'desktop', entry: 'entry.js', files: [entry] }],
    ...overrides,
  }
}

describe('ModuleStore', () => {
  it('prefers manifest.dir and falls back to the configured plugins directory', () => {
    expect(
      resolveModulePluginDir({ id: 'yolo', dir: 'custom\\yolo' }, '.config'),
    ).toBe('custom/yolo')
    expect(resolveModulePluginDir({ id: 'yolo' }, '.config')).toBe(
      '.config/plugins/yolo',
    )
  })

  it('reads exact manifest and nested entry bytes through DataAdapter', async () => {
    const index = Uint8Array.from([9, 8, 7])
    const ready = Uint8Array.from([6, 5, 4])
    const manifest = Uint8Array.from([0, 255, 1])
    const entry = Uint8Array.from([4, 3, 2, 1])
    const readBinary = jest
      .fn<Promise<ArrayBuffer>, [string]>()
      .mockResolvedValueOnce(index.buffer)
      .mockResolvedValueOnce(ready.buffer)
      .mockResolvedValueOnce(manifest.buffer)
      .mockResolvedValueOnce(entry.buffer)
    const store = new ModuleStore({
      adapter: { readBinary } as unknown as DataAdapter,
      manifest: { id: 'yolo' },
      configDir: '.config',
    })

    await expect(store.readBundledIndexBytes()).resolves.toEqual(index)
    await expect(
      store.readReadyMarkerBytes('notes', '1.2.0', 'mobile', 'a'.repeat(64)),
    ).resolves.toEqual(ready)
    await expect(store.readManifestBytes('notes', '1.2.0')).resolves.toEqual(
      manifest,
    )
    await expect(
      store.readEntryBytes('notes', '1.2.0', 'dist\\entry.js'),
    ).resolves.toEqual(entry)
    expect(readBinary).toHaveBeenNthCalledWith(
      1,
      '.config/plugins/yolo/modules/bundled.json',
    )
    expect(readBinary).toHaveBeenNthCalledWith(
      2,
      `.config/plugins/yolo/modules/notes/1.2.0/ready.mobile.${'a'.repeat(64)}.json`,
    )
    expect(readBinary).toHaveBeenNthCalledWith(
      3,
      '.config/plugins/yolo/modules/notes/1.2.0/module.json',
    )
    expect(readBinary).toHaveBeenNthCalledWith(
      4,
      '.config/plugins/yolo/modules/notes/1.2.0/dist/entry.js',
    )
  })

  it('rejects module and entry paths that can escape the module directory', async () => {
    const readBinary = jest.fn()
    const store = new ModuleStore({
      adapter: { readBinary } as unknown as DataAdapter,
      manifest: { id: 'yolo' },
      configDir: '.config',
    })

    await expect(store.readManifestBytes('../notes', '1.0.0')).rejects.toThrow(
      'path segment',
    )
    await expect(
      store.readEntryBytes('notes', '../1.0.0', 'main.js'),
    ).rejects.toThrow('path segment')
    await expect(
      store.readEntryBytes('notes', '1.0.0', '../main.js'),
    ).rejects.toThrow('relative file path')
    await expect(
      store.readEntryBytes('notes', '1.0.0', '/main.js'),
    ).rejects.toThrow('relative file path')
    await expect(store.readManifestBytes('CON', '1.0.0')).rejects.toThrow(
      'path segment',
    )
    await expect(
      store.readEntryBytes('notes', '1.0.0', 'bad\u0000name.js'),
    ).rejects.toThrow('path segment')
    expect(readBinary).not.toHaveBeenCalled()
  })

  it('parses and deterministically selects a complete platform closure', () => {
    const desktop = artifactFile()
    const mobile = artifactFile({ name: 'mobile.js', path: 'mobile.js' })
    const manifest = parseModuleArtifactManifest(
      artifactManifest({
        variants: [
          { platform: 'mobile', entry: 'mobile.js', files: [mobile] },
          { platform: 'desktop', entry: 'entry.js', files: [desktop] },
        ],
      }),
    )

    expect(selectModuleManifestVariant(manifest, 'desktop')).toMatchObject({
      platform: 'desktop',
      entry: 'entry.js',
      files: [desktop],
    })
    expect(selectModuleManifestVariant(manifest, 'mobile')).toMatchObject({
      platform: 'mobile',
      entry: 'mobile.js',
    })
    expect(Object.keys(manifest)).toEqual([
      'schemaVersion',
      'id',
      'version',
      'hostApi',
      'dataSchemas',
      'variants',
    ])
  })

  it('strictly rejects old/unknown fields and invalid release metadata', () => {
    expect(() =>
      parseModuleArtifactManifest({
        ...artifactManifest(),
        entry: artifactFile(),
        files: [artifactFile()],
      }),
    ).toThrow('unknown field')
    expect(() =>
      parseModuleArtifactManifest(artifactManifest({ hostApi: 'latest' })),
    ).toThrow('manifest is invalid')
    expect(() =>
      parseModuleArtifactManifest(
        artifactManifest({
          dataSchemas: { learning: { readMin: 2, readMax: 1, write: 1 } },
        }),
      ),
    ).toThrow('data schema')
    expect(() =>
      parseModuleArtifactManifest(
        artifactManifest({
          variants: [
            {
              platform: 'desktop',
              entry: 'entry.js',
              files: [artifactFile({ url: 'http://github.com/bad' })],
            },
          ],
        }),
      ),
    ).toThrow('URL')
  })

  it('rejects duplicate variants and case, Unicode, name, and entry aliases', () => {
    const desktop = {
      platform: 'desktop',
      entry: 'entry.js',
      files: [artifactFile()],
    }
    expect(() =>
      parseModuleArtifactManifest(
        artifactManifest({ variants: [desktop, desktop] }),
      ),
    ).toThrow('Duplicate module platform')
    expect(() =>
      parseModuleArtifactManifest(
        artifactManifest({
          variants: [
            {
              ...desktop,
              files: [
                artifactFile(),
                artifactFile({
                  role: 'data',
                  name: 'other.dat',
                  path: 'ENTRY.JS',
                  url: releaseUrl('other.dat'),
                }),
              ],
            },
          ],
        }),
      ),
    ).toThrow('Duplicate module file path')
    expect(() =>
      parseModuleArtifactManifest(
        artifactManifest({
          variants: [
            {
              ...desktop,
              files: [artifactFile({ path: 'e\u0301ntry.js' })],
            },
          ],
        }),
      ),
    ).toThrow('canonical')
    expect(() =>
      parseModuleArtifactManifest(
        artifactManifest({ variants: [{ ...desktop, entry: 'other.js' }] }),
      ),
    ).toThrow('does not match')
  })

  it('requires bounded safe file trees with reserved metadata paths', () => {
    const entry = artifactFile()
    expect(() =>
      parseModuleArtifactManifest(
        artifactManifest({
          variants: [
            {
              platform: 'desktop',
              entry: 'module.json',
              files: [{ ...entry, path: 'module.json' }],
            },
          ],
        }),
      ),
    ).toThrow('reserved')
    const deepPath = `${Array.from({ length: 17 }, (_, index) => `d${index}`).join('/')}/entry.js`
    expect(() =>
      parseModuleArtifactManifest(
        artifactManifest({
          variants: [
            {
              platform: 'desktop',
              entry: deepPath,
              files: [{ ...entry, path: deepPath }],
            },
          ],
        }),
      ),
    ).toThrow('depth limit')
    expect(() =>
      parseModuleArtifactManifest(
        artifactManifest({
          variants: [
            {
              platform: 'desktop',
              entry: 'entry.js',
              files: [
                {
                  ...entry,
                  byteSize: MAX_MODULE_ARTIFACT_FILE_BYTES + 1,
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow('file is invalid')
  })
})
