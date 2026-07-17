import { type DataAdapter, Stat } from 'obsidian'

import { RELEASE_FILE_NAMES } from './installationIntegrity'
import {
  applyRepairFiles,
  applyStagedUpdate,
  clearStagingRoot,
  getRepairMetaPath,
  getRepairStagingStatus,
  getStagingDir,
  getStagingRoot,
  getStagingStatus,
  meetsMinAppVersion,
} from './pluginUpdater'

// eslint-disable-next-line obsidianmd/hardcoded-config-path -- mock Vault#configDir for adapter paths
const MOCK_PLUGIN_DIR = 'vault/.obsidian/plugins/yolo'

class MockAdapter {
  private readonly files = new Map<string, string | ArrayBuffer>()
  private readonly folders = new Set<string>()
  private writeOrder: string[] = []

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      this.folders.add(current)
    }
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path)
    if (typeof value !== 'string') {
      throw new Error(`File is not text: ${path}`)
    }
    return value
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content)
    this.writeOrder.push(path)
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path)
    if (!(value instanceof ArrayBuffer)) {
      throw new Error(`File is not binary: ${path}`)
    }
    return value
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, content)
    this.writeOrder.push(path)
  }

  async rmdir(path: string, recursive?: boolean): Promise<void> {
    if (!recursive) {
      this.folders.delete(path)
      return
    }
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(`${path}/`) || filePath === path) {
        this.files.delete(filePath)
      }
    }
    for (const folderPath of [...this.folders]) {
      if (folderPath.startsWith(`${path}/`) || folderPath === path) {
        this.folders.delete(folderPath)
      }
    }
  }

  async stat(path: string): Promise<Stat | null> {
    if (this.files.has(path)) {
      const value = this.files.get(path)
      return {
        type: 'file',
        ctime: 0,
        mtime: 0,
        size:
          typeof value === 'string' ? value.length : (value?.byteLength ?? 0),
      }
    }
    if (this.folders.has(path)) {
      return { type: 'folder', ctime: 0, mtime: 0, size: 0 }
    }
    return null
  }

  getWriteOrder(): string[] {
    return this.writeOrder
  }
}

describe('meetsMinAppVersion', () => {
  it('returns true when app version equals minAppVersion', () => {
    expect(meetsMinAppVersion('1.8.0', '1.8.0')).toBe(true)
  })

  it('returns true when app version is newer than minAppVersion', () => {
    expect(meetsMinAppVersion('1.9.0', '1.8.0')).toBe(true)
  })

  it('returns false when app version is older than minAppVersion', () => {
    expect(meetsMinAppVersion('1.7.0', '1.8.0')).toBe(false)
  })

  it('returns true when minAppVersion is empty', () => {
    expect(meetsMinAppVersion('1.0.0', '')).toBe(true)
  })
})

describe('getStagingStatus', () => {
  it('returns ready when all staged files exist and manifest version matches', async () => {
    const adapter = new MockAdapter()
    const pluginDir = MOCK_PLUGIN_DIR
    const stagingDir = getStagingDir(pluginDir, '1.5.12.2')

    await adapter.writeBinary(`${stagingDir}/main.js`, new ArrayBuffer(8))
    await adapter.write(`${stagingDir}/styles.css`, 'body {}')
    await adapter.write(
      `${stagingDir}/manifest.json`,
      JSON.stringify({ version: '1.5.12.2', minAppVersion: '1.8.0' }),
    )

    const status = await getStagingStatus(
      adapter as unknown as DataAdapter,
      stagingDir,
      '1.5.12.2',
    )
    expect(status).toEqual({
      ready: true,
      version: '1.5.12.2',
      minAppVersion: '1.8.0',
    })
  })

  it('returns not ready when manifest version mismatches expected version', async () => {
    const adapter = new MockAdapter()
    const pluginDir = MOCK_PLUGIN_DIR
    const stagingDir = getStagingDir(pluginDir, '1.5.12.2')

    await adapter.writeBinary(`${stagingDir}/main.js`, new ArrayBuffer(8))
    await adapter.write(`${stagingDir}/styles.css`, 'body {}')
    await adapter.write(
      `${stagingDir}/manifest.json`,
      JSON.stringify({ version: '1.5.12.1', minAppVersion: '1.8.0' }),
    )

    const status = await getStagingStatus(
      adapter as unknown as DataAdapter,
      stagingDir,
      '1.5.12.2',
    )
    expect(status).toEqual({ ready: false })
  })

  it('returns not ready when a staged file is missing', async () => {
    const adapter = new MockAdapter()
    const stagingDir = getStagingDir(MOCK_PLUGIN_DIR, '1.5.12.2')

    await adapter.write(
      `${stagingDir}/manifest.json`,
      JSON.stringify({ version: '1.5.12.2' }),
    )

    const status = await getStagingStatus(
      adapter as unknown as DataAdapter,
      stagingDir,
      '1.5.12.2',
    )
    expect(status).toEqual({ ready: false })
  })
})

describe('clearStagingRoot', () => {
  it('removes all staged version directories', async () => {
    const adapter = new MockAdapter()
    const pluginDir = MOCK_PLUGIN_DIR
    const oldDir = getStagingDir(pluginDir, '1.5.12.1')
    const newerDir = getStagingDir(pluginDir, '1.5.12.2')

    await adapter.write(`${oldDir}/manifest.json`, '{}')
    await adapter.write(`${newerDir}/manifest.json`, '{}')

    await clearStagingRoot(adapter as unknown as DataAdapter, pluginDir)

    expect(await adapter.exists(oldDir)).toBe(false)
    expect(await adapter.exists(newerDir)).toBe(false)
    expect(await adapter.exists(getStagingRoot(pluginDir))).toBe(false)
  })
})

describe('applyStagedUpdate', () => {
  let reloadSpy: jest.Mock
  let previousWindow: typeof globalThis.window | undefined

  beforeEach(() => {
    reloadSpy = jest.fn()
    previousWindow = globalThis.window
    globalThis.window = {
      location: { reload: reloadSpy },
    } as unknown as Window & typeof globalThis
  })

  afterEach(() => {
    if (previousWindow === undefined) {
      // @ts-expect-error restore node test environment without window
      delete globalThis.window
    } else {
      globalThis.window = previousWindow
    }
  })

  it('writes main.js before manifest.json and reloads the app', async () => {
    const adapter = new MockAdapter()
    const pluginDir = MOCK_PLUGIN_DIR
    const stagingDir = getStagingDir(pluginDir, '1.5.12.2')

    await adapter.writeBinary(`${stagingDir}/main.js`, new ArrayBuffer(4))
    await adapter.write(`${stagingDir}/styles.css`, 'body {}')
    await adapter.write(
      `${stagingDir}/manifest.json`,
      JSON.stringify({ version: '1.5.12.2', minAppVersion: '1.8.0' }),
    )

    const plugin = {
      manifest: {
        id: 'yolo',
        dir: pluginDir,
        version: '1.5.12.1',
      },
    } as Parameters<typeof applyStagedUpdate>[1]

    const app = {
      vault: { adapter: adapter as unknown as DataAdapter },
    } as unknown as Parameters<typeof applyStagedUpdate>[0]

    const result = await applyStagedUpdate(app, plugin, '1.5.12.2')
    expect(result).toEqual({ ok: true })
    expect(reloadSpy).toHaveBeenCalled()

    const writeOrder = adapter.getWriteOrder()
    const mainIndex = writeOrder.indexOf(`${pluginDir}/main.js`)
    const manifestIndex = writeOrder.indexOf(`${pluginDir}/manifest.json`)
    expect(mainIndex).toBeGreaterThanOrEqual(0)
    expect(manifestIndex).toBeGreaterThan(mainIndex)
  })

  it('rejects install when minAppVersion is not met', async () => {
    const adapter = new MockAdapter()
    const pluginDir = MOCK_PLUGIN_DIR
    const stagingDir = getStagingDir(pluginDir, '2.0.0')

    await adapter.writeBinary(`${stagingDir}/main.js`, new ArrayBuffer(4))
    await adapter.write(`${stagingDir}/styles.css`, 'body {}')
    await adapter.write(
      `${stagingDir}/manifest.json`,
      JSON.stringify({ version: '2.0.0', minAppVersion: '9.9.9' }),
    )

    const plugin = {
      manifest: {
        id: 'yolo',
        dir: pluginDir,
        version: '1.0.0',
      },
    } as Parameters<typeof applyStagedUpdate>[1]

    const app = {
      vault: { adapter: adapter as unknown as DataAdapter },
    } as unknown as Parameters<typeof applyStagedUpdate>[0]

    const result = await applyStagedUpdate(app, plugin, '2.0.0')
    expect(result).toEqual({ ok: false, reason: 'min_app_version' })
    expect(reloadSpy).not.toHaveBeenCalled()
  })
})

describe('getRepairStagingStatus', () => {
  it('returns ready when repair meta and requested files exist', async () => {
    const adapter = new MockAdapter()
    const pluginDir = MOCK_PLUGIN_DIR
    const stagingDir = getStagingDir(pluginDir, '1.5.12.2')

    await adapter.write(
      `${stagingDir}/styles.css`,
      '/* @yolo-version: 1.5.12.2 */\nbody {}',
    )
    await adapter.write(
      getRepairMetaPath(stagingDir),
      JSON.stringify({
        version: '1.5.12.2',
        files: [RELEASE_FILE_NAMES.stylesCss],
      }),
    )

    const status = await getRepairStagingStatus(
      adapter as unknown as DataAdapter,
      stagingDir,
      '1.5.12.2',
    )
    expect(status).toEqual({
      ready: true,
      version: '1.5.12.2',
      files: [RELEASE_FILE_NAMES.stylesCss],
      minAppVersion: '',
    })
  })
})

describe('applyRepairFiles', () => {
  let reloadSpy: jest.Mock
  let previousWindow: typeof globalThis.window | undefined

  beforeEach(() => {
    reloadSpy = jest.fn()
    previousWindow = globalThis.window
    globalThis.window = {
      location: { reload: reloadSpy },
    } as unknown as Window & typeof globalThis
  })

  afterEach(() => {
    if (previousWindow === undefined) {
      // @ts-expect-error restore node test environment without window
      delete globalThis.window
    } else {
      globalThis.window = previousWindow
    }
  })

  it('writes only staged repair files and reloads the app', async () => {
    const adapter = new MockAdapter()
    const pluginDir = MOCK_PLUGIN_DIR
    const stagingDir = getStagingDir(pluginDir, '1.5.12.2')

    await adapter.write(
      `${stagingDir}/styles.css`,
      '/* @yolo-version: 1.5.12.2 */\nbody { color: red; }',
    )
    await adapter.write(
      getRepairMetaPath(stagingDir),
      JSON.stringify({
        version: '1.5.12.2',
        files: [RELEASE_FILE_NAMES.stylesCss],
      }),
    )

    const plugin = {
      manifest: {
        id: 'yolo',
        dir: pluginDir,
        version: '1.5.12.2',
      },
    } as Parameters<typeof applyRepairFiles>[1]

    const app = {
      vault: { adapter: adapter as unknown as DataAdapter },
    } as unknown as Parameters<typeof applyRepairFiles>[0]

    const result = await applyRepairFiles(app, plugin, '1.5.12.2')
    expect(result).toEqual({ ok: true })
    expect(reloadSpy).toHaveBeenCalled()
    expect(adapter.getWriteOrder()).toContain(`${pluginDir}/styles.css`)
  })
})
