import type { DataAdapter } from 'obsidian'

import {
  MAX_MODULE_ARTIFACT_FILE_BYTES,
  ModuleStore,
  moduleArtifactReleaseParent,
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
    const manifest = Uint8Array.from([0, 255, 1])
    const entry = Uint8Array.from([4, 3, 2, 1])
    const readBinary = jest
      .fn<Promise<ArrayBuffer>, [string]>()
      .mockResolvedValueOnce(index.buffer)
      .mockResolvedValueOnce(manifest.buffer)
      .mockResolvedValueOnce(entry.buffer)
    const store = new ModuleStore({
      adapter: { readBinary } as unknown as DataAdapter,
      manifest: { id: 'yolo' },
      configDir: '.config',
    })

    await expect(store.readBundledIndexBytes()).resolves.toEqual(index)
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
      '.config/plugins/yolo/modules/notes/1.2.0/module.json',
    )
    expect(readBinary).toHaveBeenNthCalledWith(
      3,
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

  it('recursively removes only the resolved version root and verifies absence', async () => {
    const root = '.config/plugins/yolo/modules/notes/1.2.0'
    let present = true
    const stat = jest.fn(async (path: string) =>
      path === root && present ? { type: 'folder' as const } : null,
    )
    const rmdir = jest.fn(async () => {
      present = false
    })
    const store = new ModuleStore({
      adapter: { stat, rmdir } as unknown as DataAdapter,
      manifest: { id: 'yolo', dir: '.config/plugins/yolo' },
      configDir: '.config',
    })

    await expect(
      store.removeVersionArtifacts('notes', '1.2.0'),
    ).resolves.toBeUndefined()
    expect(rmdir).toHaveBeenCalledWith(root, true)
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('makes version removal idempotent, including a completed uncertain call', async () => {
    const stat = jest
      .fn<Promise<{ type: 'folder' } | null>, [string]>()
      .mockResolvedValueOnce({ type: 'folder' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
    const rmdir = jest.fn(async () => {
      throw new Error('uncertain removal')
    })
    const store = new ModuleStore({
      adapter: { stat, rmdir } as unknown as DataAdapter,
      manifest: { id: 'yolo', dir: '.config/plugins/yolo' },
      configDir: '.config',
    })

    await expect(
      store.removeVersionArtifacts('notes', '1.2.0'),
    ).resolves.toBeUndefined()
    await expect(
      store.removeVersionArtifacts('notes', '1.2.0'),
    ).resolves.toBeUndefined()
    expect(rmdir).toHaveBeenCalledTimes(1)
  })

  it('fails closed for unsafe removal capability, roots, paths, and readback', async () => {
    const noRemoval = new ModuleStore({
      adapter: { stat: async () => null } as unknown as DataAdapter,
      manifest: { id: 'yolo', dir: '.config/plugins/yolo' },
      configDir: '.config',
    })
    await expect(
      noRemoval.removeVersionArtifacts('notes', '1.0.0'),
    ).rejects.toThrow('cannot safely remove')

    const fileRoot = new ModuleStore({
      adapter: {
        stat: async () => ({ type: 'file' }),
        rmdir: jest.fn(),
      } as unknown as DataAdapter,
      manifest: { id: 'yolo', dir: '.config/plugins/yolo' },
      configDir: '.config',
    })
    await expect(
      fileRoot.removeVersionArtifacts('notes', '1.0.0'),
    ).rejects.toThrow('not a folder')

    const remains = new ModuleStore({
      adapter: {
        stat: async () => ({ type: 'folder' }),
        rmdir: async () => undefined,
      } as unknown as DataAdapter,
      manifest: { id: 'yolo', dir: '.config/plugins/yolo' },
      configDir: '.config',
    })
    await expect(
      remains.removeVersionArtifacts('notes', '1.0.0'),
    ).rejects.toThrow('remain after removal')
    await expect(
      remains.removeVersionArtifacts('../notes', '1.0.0'),
    ).rejects.toThrow('path segment')
    await expect(
      remains.removeVersionArtifacts('notes', '../1.0.0'),
    ).rejects.toThrow('path segment')
  })

  it.each([
    {
      label: 'absolute manifest directory',
      manifest: { id: 'yolo', dir: '/vault/.config/plugins/yolo' },
      configDir: '.config',
    },
    {
      label: 'drive-qualified manifest directory',
      manifest: { id: 'yolo', dir: 'C:\\vault\\plugins\\yolo' },
      configDir: '.config',
    },
    {
      label: 'traversing manifest directory',
      manifest: { id: 'yolo', dir: '.config/plugins/other/../yolo' },
      configDir: '.config',
    },
    {
      label: 'separator alias',
      manifest: { id: 'yolo', dir: '.config\\plugins\\yolo' },
      configDir: '.config',
    },
    {
      label: 'case alias',
      manifest: { id: 'yolo', dir: '.config/plugins/YOLO' },
      configDir: '.config',
    },
    {
      label: 'Unicode alias',
      manifest: { id: 'yolo', dir: '.config/plugins/yol\uFF4F' },
      configDir: '.config',
    },
    {
      label: 'absolute config directory',
      manifest: { id: 'yolo' },
      configDir: '/vault/.config',
    },
    {
      label: 'drive-qualified config directory',
      manifest: { id: 'yolo' },
      configDir: 'C:\\vault',
    },
    {
      label: 'traversing config directory',
      manifest: { id: 'yolo' },
      configDir: '.config/..',
    },
    {
      label: 'non-canonical Unicode config directory',
      manifest: { id: 'yolo' },
      configDir: '.co\u0301nfig',
    },
  ])('rejects $label before recursive removal', async (options) => {
    const rmdir = jest.fn()
    const stat = jest.fn()
    const store = new ModuleStore({
      adapter: { stat, rmdir } as unknown as DataAdapter,
      manifest: options.manifest,
      configDir: options.configDir,
    })

    await expect(
      store.removeVersionArtifacts('notes', '1.0.0'),
    ).rejects.toThrow('Module artifact removal')
    expect(stat).not.toHaveBeenCalled()
    expect(rmdir).not.toHaveBeenCalled()
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

  it('parses encoded release tags and compares their canonical parent identity', () => {
    const encodedRoot =
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv0.1.0'
    expect(() =>
      parseModuleArtifactManifest(
        artifactManifest({
          version: '0.1.0',
          variants: [
            {
              platform: 'desktop',
              entry: 'entry.js',
              files: [artifactFile({ url: `${encodedRoot}/entry.js` })],
            },
          ],
        }),
      ),
    ).not.toThrow()
    expect(moduleArtifactReleaseParent(`${encodedRoot}/module.json`)).toBe(
      moduleArtifactReleaseParent(
        `${encodedRoot.replace('%2F', '%2f')}/entry.js`,
      ),
    )
    expect(
      moduleArtifactReleaseParent(
        `${encodedRoot.replace('v0.1.0', 'v0.1.1')}/entry.js`,
      ),
    ).not.toBe(moduleArtifactReleaseParent(`${encodedRoot}/module.json`))
  })

  it.each(['learning/v0.1.0', 'learning%252Fv0.1.0', 'learning%2F..'])(
    'rejects unsafe release tag form %s in artifact URLs',
    (tag) => {
      expect(() =>
        parseModuleArtifactManifest(
          artifactManifest({
            variants: [
              {
                platform: 'desktop',
                entry: 'entry.js',
                files: [
                  artifactFile({
                    url: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${tag}/entry.js`,
                  }),
                ],
              },
            ],
          }),
        ),
      ).toThrow('URL')
    },
  )

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
