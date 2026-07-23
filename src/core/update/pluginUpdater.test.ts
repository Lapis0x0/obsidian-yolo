import { type DataAdapter, Stat, requestUrl } from 'obsidian'

import { RELEASE_FILE_NAMES } from './installationIntegrity'
import {
  applyRepairFiles,
  applyStagedUpdate,
  clearStagingRoot,
  downloadReleaseToStaging,
  downloadRepairFilesToStaging,
  getRepairMetaPath,
  getRepairStagingStatus,
  getStagingDir,
  getStagingRoot,
  getStagingStatus,
  meetsMinAppVersion,
} from './pluginUpdater'

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

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

describe('signed update downloads', () => {
  beforeEach(() => mockedRequestUrl.mockReset())

  it('falls back from Pages and verifies every signed asset', async () => {
    const adapter = new MockAdapter()
    const values = {
      mainJs: new TextEncoder().encode('main'),
      manifestJson: new TextEncoder().encode(
        JSON.stringify({ version: '1.7.0', minAppVersion: '1.8.0' }),
      ),
      stylesCss: new TextEncoder().encode('style'),
    }
    const digest = async (bytes: Uint8Array) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
    const asset = async (key: keyof typeof values, name: string) => ({
      url: `https://github.com/${name}`,
      mirrorUrl: `https://updates.yoloapp.dev/${name}`,
      size: values[key].byteLength,
      sha256: await digest(values[key]),
    })
    mockedRequestUrl.mockImplementation((request) => {
      const url = typeof request === 'string' ? request : request.url
      if (url.startsWith('https://updates.')) {
        return Promise.resolve({
          status: 503,
          headers: {},
          text: '',
          arrayBuffer: new ArrayBuffer(0),
          json: null,
        }) as never
      }
      const name = url.split('/').at(-1)
      const bytes =
        name === 'main.js'
          ? values.mainJs
          : name === 'manifest.json'
            ? values.manifestJson
            : values.stylesCss
      return Promise.resolve({
        status: 200,
        headers: {},
        text: new TextDecoder().decode(bytes),
        arrayBuffer: bytes.slice().buffer,
        json: null,
      }) as never
    })
    await downloadReleaseToStaging({
      adapter: adapter as unknown as DataAdapter,
      pluginDir: MOCK_PLUGIN_DIR,
      version: '1.7.0',
      assets: {
        mainJs: await asset('mainJs', 'main.js'),
        manifestJson: await asset('manifestJson', 'manifest.json'),
        stylesCss: await asset('stylesCss', 'styles.css'),
      },
    })
    await expect(
      getStagingStatus(
        adapter as unknown as DataAdapter,
        getStagingDir(MOCK_PLUGIN_DIR, '1.7.0'),
        '1.7.0',
      ),
    ).resolves.toMatchObject({ ready: true, version: '1.7.0' })
    expect(mockedRequestUrl).toHaveBeenCalledTimes(6)
  })

  it('falls back to GitHub when the Pages request never settles', async () => {
    jest.useFakeTimers()
    try {
      const adapter = new MockAdapter()
      const bytes = new TextEncoder().encode('style')
      let notifyPagesStarted!: () => void
      const pagesStarted = new Promise<void>((resolve) => {
        notifyPagesStarted = resolve
      })
      mockedRequestUrl.mockImplementation((request) => {
        const url = typeof request === 'string' ? request : request.url
        if (url.startsWith('https://updates.')) {
          notifyPagesStarted()
          return new Promise(() => undefined) as never
        }
        return Promise.resolve({
          status: 200,
          headers: {},
          text: 'style',
          arrayBuffer: bytes.slice().buffer,
          json: null,
        }) as never
      })
      const asset = {
        url: 'https://github.com/styles.css',
        mirrorUrl: 'https://updates.yoloapp.dev/styles.css',
        size: bytes.byteLength,
      }

      const downloading = downloadRepairFilesToStaging({
        adapter: adapter as unknown as DataAdapter,
        pluginDir: MOCK_PLUGIN_DIR,
        version: '1.7.0',
        assets: { mainJs: asset, manifestJson: asset, stylesCss: asset },
        files: [RELEASE_FILE_NAMES.stylesCss],
      })
      await pagesStarted
      await jest.advanceTimersByTimeAsync(30_000)

      await expect(downloading).resolves.toBeUndefined()
      expect(mockedRequestUrl).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
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
