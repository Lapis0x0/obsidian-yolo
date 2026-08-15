jest.mock('obsidian')

import { App, Platform } from 'obsidian'

import {
  ModuleChatModeRegistry,
  snapshotModuleChatMode,
} from '../modules/moduleChatModeRegistry'
import type { YoloModuleChatModeV1 } from '../modules/types'

import { McpCoordinator } from './mcpCoordinator'
import type { McpManager } from './mcpManager'

const OBSIDIAN_CONFIG_DIR = ['.', 'obsidian'].join('')

const baseMode = (
  overrides: Partial<YoloModuleChatModeV1> = {},
): YoloModuleChatModeV1 =>
  snapshotModuleChatMode({
    id: 'chat',
    label: 'Learning',
    personaPrompt: 'You are a helpful tutor.',
    capability: 'vault-read',
    tools: [
      {
        name: 'get_generation_status',
        description: 'Reads status.',
        inputSchema: { type: 'object', properties: {} },
        handler: () => ({ content: 'ok' }),
      },
    ],
    ...overrides,
  } as YoloModuleChatModeV1)

describe('McpCoordinator module chat mode replay', () => {
  const originalIsDesktop = Platform.isDesktop

  beforeEach(() => {
    // Keep tests on the simpler mobile (remoteMcpDisabled) McpManager path so
    // remote-server connection wiring stays out of scope, matching
    // mcpManager.inProcessRegistry.test.ts.
    Platform.isDesktop = false
  })

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  function createCoordinator(
    registry?: ModuleChatModeRegistry,
  ): McpCoordinator {
    return new McpCoordinator({
      app: { vault: { configDir: OBSIDIAN_CONFIG_DIR } } as unknown as App,
      pluginId: 'test-plugin',
      getSettings: () =>
        ({
          mcp: { servers: [], builtinCapabilityOptions: {} },
          webSearch: {
            providers: [],
            defaultProviderId: undefined,
            common: {
              resultSize: 8,
              searchTimeoutMs: 15000,
              scrapeTimeoutMs: 20000,
            },
          },
        }) as never,
      openApplyReview: jest.fn(),
      registerSettingsListener: () => () => {},
      moduleChatModeRegistry: registry,
    })
  }

  function toolNames(manager: McpManager) {
    return manager
      .listAvailableTools()
      .then((tools) => tools.map((tool) => tool.name))
  }

  it('replays modes already in the registry onto a newly created manager', async () => {
    const registry = new ModuleChatModeRegistry()
    registry.add('learning', baseMode())
    const coordinator = createCoordinator(registry)

    const manager = await coordinator.getMcpManager()

    await expect(toolNames(manager)).resolves.toContain(
      'module-mode-learning-chat__get_generation_status',
    )
    expect(registry.getSnapshot()[0].availability).toEqual({
      status: 'available',
    })
  })

  it('registers a mode added to the registry after the manager is ready', async () => {
    const registry = new ModuleChatModeRegistry()
    const coordinator = createCoordinator(registry)
    const manager = await coordinator.getMcpManager()

    await expect(toolNames(manager)).resolves.not.toContain(
      expect.stringContaining('module-mode-learning-chat'),
    )

    registry.add('learning', baseMode())

    await expect(toolNames(manager)).resolves.toContain(
      'module-mode-learning-chat__get_generation_status',
    )
  })

  it('unregisters a mode removed from the registry', async () => {
    const registry = new ModuleChatModeRegistry()
    const coordinator = createCoordinator(registry)
    const manager = await coordinator.getMcpManager()
    registry.add('learning', baseMode())
    await expect(toolNames(manager)).resolves.toContain(
      'module-mode-learning-chat__get_generation_status',
    )

    registry.remove('learning', 'chat')

    const names = await toolNames(manager)
    expect(
      names.some((name) => name.startsWith('module-mode-learning-chat__')),
    ).toBe(false)
  })

  it('marks a single colliding mode unavailable without blocking other modes, and warns once', async () => {
    const registry = new ModuleChatModeRegistry()
    const coordinator = createCoordinator(registry)
    const manager = await coordinator.getMcpManager()
    // Simulate a pre-existing user-configured MCP server occupying the exact
    // name this mode would need (see mcpManager.inProcessRegistry.test.ts for
    // the same seeding technique).
    ;(manager as unknown as { servers: { name: string }[] }).servers = [
      { name: 'module-mode-learning-chat' },
    ]
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    // Two separate registry mutations, each triggering its own reconcile
    // pass; the still-failing "chat" mode is retried (and warns) on both,
    // since reconcile has no separate "give up" state — only "registered"
    // vs. "not yet registered". This is expected: reconcile is idempotent
    // per pass, not memoized across passes.
    registry.add('learning', baseMode({ id: 'chat' }))
    registry.add('learning', baseMode({ id: 'quiz' }))

    expect(registry.getSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullModeId: 'module:learning:chat',
          availability: expect.objectContaining({ status: 'unavailable' }),
        }),
        expect.objectContaining({
          fullModeId: 'module:learning:quiz',
          availability: { status: 'available' },
        }),
      ]),
    )
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toContain('module:learning:chat')
    expect(warn.mock.calls[1][0]).toContain('module:learning:chat')

    await expect(toolNames(manager)).resolves.toContain(
      'module-mode-learning-quiz__get_generation_status',
    )
    warn.mockRestore()
  })

  it('does not double-register from the setAvailability reentrant notification', async () => {
    const registry = new ModuleChatModeRegistry()
    const coordinator = createCoordinator(registry)
    const manager = await coordinator.getMcpManager()
    const registerSpy = jest.spyOn(manager, 'registerInProcessServer')

    registry.add('learning', baseMode())
    // Let any (incorrect) reentrant microtask-queued work settle before
    // asserting the call count.
    await Promise.resolve()

    expect(registerSpy).toHaveBeenCalledTimes(1)
  })

  it('replays onto a freshly rebuilt manager after cleanup()', async () => {
    const registry = new ModuleChatModeRegistry()
    registry.add('learning', baseMode())
    const coordinator = createCoordinator(registry)
    const firstManager = await coordinator.getMcpManager()
    await expect(toolNames(firstManager)).resolves.toContain(
      'module-mode-learning-chat__get_generation_status',
    )

    coordinator.cleanup()
    const secondManager = await coordinator.getMcpManager()

    expect(secondManager).not.toBe(firstManager)
    await expect(toolNames(secondManager)).resolves.toContain(
      'module-mode-learning-chat__get_generation_status',
    )
  })

  it('does nothing when no registry is supplied', async () => {
    const coordinator = createCoordinator(undefined)
    await expect(coordinator.getMcpManager()).resolves.toBeDefined()
  })
})
