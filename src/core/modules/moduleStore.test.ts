import type { DataAdapter } from 'obsidian'

import {
  MAX_MODULE_ARTIFACT_FILE_BYTES,
  ModuleStore,
  parseModuleArtifactManifest,
  resolveModulePluginDir,
} from './moduleStore'

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
    await expect(store.readReadyMarkerBytes('notes', '1.2.0')).resolves.toEqual(
      ready,
    )
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
      '.config/plugins/yolo/modules/notes/1.2.0/ready.json',
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

  it('requires a complete, bounded file closure with reserved metadata paths', () => {
    const entry = {
      role: 'entry' as const,
      path: 'entry.js',
      byteSize: 3,
      sha256: 'a'.repeat(64),
    }
    expect(
      parseModuleArtifactManifest({
        schemaVersion: 1,
        id: 'learning',
        version: '1.0.0',
        hostApi: 1,
        entry,
        files: [entry],
      }),
    ).toMatchObject({ id: 'learning', files: [entry] })
    expect(() =>
      parseModuleArtifactManifest({
        schemaVersion: 1,
        id: 'learning',
        version: '1.0.0',
        hostApi: 1,
        entry: { ...entry, path: 'module.json' },
        files: [{ ...entry, path: 'module.json' }],
      }),
    ).toThrow('reserved')
    expect(() =>
      parseModuleArtifactManifest({
        schemaVersion: 1,
        id: 'learning',
        version: '1.0.0',
        hostApi: 1,
        entry: { ...entry, path: 'MODULE.JSON' },
        files: [{ ...entry, path: 'MODULE.JSON' }],
      }),
    ).toThrow('reserved')
    const deepPath = `${Array.from({ length: 17 }, (_, index) => `d${index}`).join('/')}/entry.js`
    expect(() =>
      parseModuleArtifactManifest({
        schemaVersion: 1,
        id: 'learning',
        version: '1.0.0',
        hostApi: 1,
        entry: { ...entry, path: deepPath },
        files: [{ ...entry, path: deepPath }],
      }),
    ).toThrow('depth limit')
    expect(() =>
      parseModuleArtifactManifest({
        schemaVersion: 1,
        id: 'learning',
        version: '1.0.0',
        hostApi: 1,
        entry: { ...entry, byteSize: MAX_MODULE_ARTIFACT_FILE_BYTES + 1 },
        files: [{ ...entry, byteSize: MAX_MODULE_ARTIFACT_FILE_BYTES + 1 }],
      }),
    ).toThrow('file is invalid')
  })
})
