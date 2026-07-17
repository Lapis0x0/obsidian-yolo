import type { DataAdapter } from 'obsidian'

import { ModuleStore, resolveModulePluginDir } from './moduleStore'

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
    const manifest = Uint8Array.from([0, 255, 1])
    const entry = Uint8Array.from([4, 3, 2, 1])
    const readBinary = jest
      .fn<Promise<ArrayBuffer>, [string]>()
      .mockResolvedValueOnce(manifest.buffer)
      .mockResolvedValueOnce(entry.buffer)
    const store = new ModuleStore({
      adapter: { readBinary } as unknown as DataAdapter,
      manifest: { id: 'yolo' },
      configDir: '.config',
    })

    await expect(store.readManifestBytes('notes', '1.2.0')).resolves.toEqual(
      manifest,
    )
    await expect(
      store.readEntryBytes('notes', '1.2.0', 'dist\\entry.js'),
    ).resolves.toEqual(entry)
    expect(readBinary).toHaveBeenNthCalledWith(
      1,
      '.config/plugins/yolo/modules/notes/1.2.0/module.json',
    )
    expect(readBinary).toHaveBeenNthCalledWith(
      2,
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
    expect(readBinary).not.toHaveBeenCalled()
  })
})
