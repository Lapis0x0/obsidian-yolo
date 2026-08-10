const createDesktopCliRuntimeCoordinator = jest.fn()
jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react')
  return { __esModule: true, ...actual, default: actual }
})
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: () => null,
  defaultUrlTransform: (url: string) => url,
}))
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('remark-math', () => ({ __esModule: true, default: jest.fn() }))

jest.mock('obsidian', () => {
  class ObsidianBase {}
  const Platform = { isDesktop: true, isMobile: false }
  return new Proxy(
    {
      Platform,
      Plugin: ObsidianBase,
      normalizePath: (path: string) => path,
      getLanguage: () => 'en',
    },
    {
      get(target, property: string) {
        if (property in target) {
          return target[property as keyof typeof target]
        }
        return ObsidianBase
      },
    },
  )
})

jest.mock('./ChatView', () => ({ ChatView: jest.fn() }))
jest.mock('./constants/bakedVersion', () => ({ BAKED_PLUGIN_VERSION: 'test' }))
jest.mock(
  './core/runtime-components',
  () =>
    new Proxy(
      { BAKED_RUNTIME_COMPONENT_REGISTRY: {} },
      {
        get: (target, property: string) =>
          (target as Record<string, unknown>)[property] ?? jest.fn(),
      },
    ),
)
jest.mock('./core/cli-runtime/coordinator', () => ({
  createDesktopCliRuntimeCoordinator: (...args: unknown[]) =>
    createDesktopCliRuntimeCoordinator(...args),
}))
import { Platform } from 'obsidian'

import type {
  CliRuntimeCoordinator,
  CliRuntimeScope,
} from './core/cli-runtime/coordinator'
import YoloPlugin from './main'

type TestPlugin = {
  app: unknown
  settings: YoloPlugin['settings']
  isUnloaded: boolean
  getCliRuntimeCoordinator: YoloPlugin['getCliRuntimeCoordinator']
  createCliRuntimeScope: YoloPlugin['createCliRuntimeScope']
  disposeCliRuntimeCoordinator(): void
}

const createScope = (name: string): CliRuntimeScope =>
  ({ name, dispose: jest.fn() }) as unknown as CliRuntimeScope

const createPlugin = (): TestPlugin => {
  const plugin = Object.create(YoloPlugin.prototype) as unknown as TestPlugin
  Object.assign(plugin, {
    app: { vault: { adapter: {} } },
    settings: { yolo: { baseDir: 'first' } },
    isUnloaded: false,
  })
  return plugin
}

const flushPromises = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('YoloPlugin CLI runtime lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Platform.isDesktop = true
    Platform.isMobile = false
  })

  it('does not construct the desktop coordinator on mobile', async () => {
    Platform.isDesktop = false
    Platform.isMobile = true
    const plugin = createPlugin()

    await expect(plugin.getCliRuntimeCoordinator()).resolves.toBeNull()
    await expect(plugin.createCliRuntimeScope()).resolves.toBeNull()

    expect(createDesktopCliRuntimeCoordinator).not.toHaveBeenCalled()
  })

  it('shares one coordinator promise and creates distinct ChatView scopes', async () => {
    const firstScope = createScope('first')
    const secondScope = createScope('second')
    const coordinator: CliRuntimeCoordinator = {
      createScope: jest
        .fn<
          ReturnType<CliRuntimeCoordinator['createScope']>,
          Parameters<CliRuntimeCoordinator['createScope']>
        >()
        .mockReturnValueOnce(firstScope)
        .mockReturnValueOnce(secondScope),
      subscribeToRunSummaries: jest.fn(() => () => undefined),
      dispose: jest.fn(async () => undefined),
    }
    createDesktopCliRuntimeCoordinator.mockResolvedValue(coordinator)
    const plugin = createPlugin()

    const firstAccess = plugin.getCliRuntimeCoordinator()
    const secondAccess = plugin.getCliRuntimeCoordinator()
    expect(secondAccess).toBe(firstAccess)
    await expect(firstAccess).resolves.toBe(coordinator)
    await expect(plugin.createCliRuntimeScope()).resolves.toBe(firstScope)
    await expect(plugin.createCliRuntimeScope()).resolves.toBe(secondScope)

    expect(createDesktopCliRuntimeCoordinator).toHaveBeenCalledTimes(1)
    expect(firstScope).not.toBe(secondScope)

    const coordinatorOptions = createDesktopCliRuntimeCoordinator.mock
      .calls[0][0] as { getSettings: () => unknown }
    plugin.settings = { yolo: { baseDir: 'second' } } as typeof plugin.settings
    expect(coordinatorOptions.getSettings()).toBe(plugin.settings)
  })

  it('disposes a coordinator that finishes creation during unload', async () => {
    let resolveCoordinator!: (coordinator: CliRuntimeCoordinator) => void
    const pendingCoordinator = new Promise<CliRuntimeCoordinator>((resolve) => {
      resolveCoordinator = resolve
    })
    createDesktopCliRuntimeCoordinator.mockReturnValue(pendingCoordinator)
    const disposeCoordinator = jest.fn(async () => undefined)
    const coordinator: CliRuntimeCoordinator = {
      createScope: jest.fn(),
      subscribeToRunSummaries: jest.fn(() => () => undefined),
      dispose: disposeCoordinator,
    }
    const plugin = createPlugin()

    const access = plugin.getCliRuntimeCoordinator()
    await flushPromises()
    plugin.isUnloaded = true
    plugin.disposeCliRuntimeCoordinator()
    resolveCoordinator(coordinator)

    await expect(access).resolves.toBeNull()
    await flushPromises()
    expect(disposeCoordinator).toHaveBeenCalledTimes(1)
    expect(plugin.getCliRuntimeCoordinator()).resolves.toBeNull()
  })

  it('starts coordinator disposal from the plugin unload hook', () => {
    const plugin = createPlugin()
    const stopAfterCoordinatorCleanup = new Error('stop after CLI cleanup')
    const disposeCliRuntimeCoordinator = jest.fn(() => {
      throw stopAfterCoordinatorCleanup
    })
    plugin.disposeCliRuntimeCoordinator = disposeCliRuntimeCoordinator

    expect(() =>
      YoloPlugin.prototype.onunload.call(
        plugin as unknown as InstanceType<typeof YoloPlugin>,
      ),
    ).toThrow(stopAfterCoordinatorCleanup)

    expect(plugin.isUnloaded).toBe(true)
    expect(disposeCliRuntimeCoordinator).toHaveBeenCalledTimes(1)
  })
})
