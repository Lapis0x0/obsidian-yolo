import { ToolCallResponseStatus } from '../../types/tool-call.types'

import {
  MAX_MODULE_CHAT_MODES_PER_MODULE,
  MAX_MODULE_CHAT_MODE_SKILLS,
  ModuleChatModeRegistry,
  buildModuleChatModeFullId,
  buildModuleChatModeServerName,
  createModuleChatModeToolServer,
  snapshotModuleChatMode,
} from './moduleChatModeRegistry'
import type { YoloModuleChatModeToolV1, YoloModuleChatModeV1 } from './types'

const baseMode = (
  overrides: Partial<YoloModuleChatModeV1> = {},
): YoloModuleChatModeV1 =>
  ({
    id: 'chat',
    label: 'Learning',
    personaPrompt: 'You are a helpful tutor.',
    capability: 'vault-read',
    ...overrides,
  }) as YoloModuleChatModeV1

describe('buildModuleChatModeFullId / buildModuleChatModeServerName', () => {
  it('namespaces the full id and server name by module', () => {
    expect(buildModuleChatModeFullId('learning', 'chat')).toBe(
      'module:learning:chat',
    )
    expect(buildModuleChatModeServerName('learning', 'chat')).toBe(
      'module-mode-learning-chat',
    )
  })
})

describe('snapshotModuleChatMode', () => {
  it('validates and freezes a minimal declaration', () => {
    const snapshot = snapshotModuleChatMode(baseMode())
    expect(snapshot).toEqual({
      id: 'chat',
      label: 'Learning',
      personaPrompt: 'You are a helpful tutor.',
      capability: 'vault-read',
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('rejects an id that does not match ^[a-z][a-z0-9-]*$', () => {
    expect(() => snapshotModuleChatMode(baseMode({ id: 'Chat' }))).toThrow(
      /id must match/,
    )
    expect(() => snapshotModuleChatMode(baseMode({ id: '1chat' }))).toThrow(
      /id must match/,
    )
    expect(() => snapshotModuleChatMode(baseMode({ id: 'chat_mode' }))).toThrow(
      /id must match/,
    )
  })

  it('rejects a non-empty icon that is only whitespace', () => {
    expect(() => snapshotModuleChatMode(baseMode({ icon: '   ' }))).toThrow(
      /icon must be a non-empty string/,
    )
  })

  it('rejects an empty persona prompt', () => {
    expect(() =>
      snapshotModuleChatMode(baseMode({ personaPrompt: '  ' })),
    ).toThrow(/persona prompt must be a non-empty string/)
  })

  it('rejects an invalid capability', () => {
    expect(() =>
      snapshotModuleChatMode(baseMode({ capability: 'vault-delete' as never })),
    ).toThrow(/capability is invalid/)
  })

  it('accepts a full declaration including tools with requiresApproval', () => {
    const tool: YoloModuleChatModeToolV1 = {
      name: 'start_course_generation',
      description: 'Starts generation.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({ content: 'ok' }),
      requiresApproval: true,
    }
    const snapshot = snapshotModuleChatMode(
      baseMode({
        description: 'Learning mode',
        icon: 'graduation-cap',
        tools: [tool],
      }),
    )
    expect(snapshot.tools).toHaveLength(1)
    expect(snapshot.tools?.[0]).toMatchObject({
      name: 'start_course_generation',
      requiresApproval: true,
    })
    expect(Object.isFrozen(snapshot.tools)).toBe(true)
    expect(Object.isFrozen(snapshot.tools?.[0])).toBe(true)
  })

  it('defaults requiresApproval to absent when not declared', () => {
    const tool: YoloModuleChatModeToolV1 = {
      name: 'get_generation_status',
      description: 'Reads status.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({ content: 'ok' }),
    }
    const snapshot = snapshotModuleChatMode(baseMode({ tools: [tool] }))
    expect(snapshot.tools?.[0]).not.toHaveProperty('requiresApproval')
  })

  it('rejects a tool name that does not match the module tool name format', () => {
    const tool = {
      name: 'Start-Course',
      description: 'Bad name.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({ content: 'ok' }),
    } as YoloModuleChatModeToolV1
    expect(() => snapshotModuleChatMode(baseMode({ tools: [tool] }))).toThrow(
      /tool name must match/,
    )
  })

  it('rejects more than 16 tools', () => {
    const tools: YoloModuleChatModeToolV1[] = Array.from(
      { length: 17 },
      (_, index) => ({
        name: `tool_${index}`,
        description: 'A tool.',
        inputSchema: { type: 'object', properties: {} },
        handler: () => ({ content: 'ok' }),
      }),
    )
    expect(() => snapshotModuleChatMode(baseMode({ tools }))).toThrow(
      /must not exceed 16/,
    )
  })

  it('rejects duplicate tool names', () => {
    const makeTool = (): YoloModuleChatModeToolV1 => ({
      name: 'dup',
      description: 'A tool.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({ content: 'ok' }),
    })
    expect(() =>
      snapshotModuleChatMode(baseMode({ tools: [makeTool(), makeTool()] })),
    ).toThrow(/is duplicated/)
  })

  it('rejects a non-boolean requiresApproval', () => {
    const tool = {
      name: 'tool',
      description: 'A tool.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({ content: 'ok' }),
      requiresApproval: 'yes',
    } as unknown as YoloModuleChatModeToolV1
    expect(() => snapshotModuleChatMode(baseMode({ tools: [tool] }))).toThrow(
      /requiresApproval must be a boolean/,
    )
  })

  it('accepts an empty skills array', () => {
    expect(() => snapshotModuleChatMode(baseMode({ skills: [] }))).not.toThrow()
  })

  it('accepts and freezes a valid skills array', () => {
    const snapshot = snapshotModuleChatMode(
      baseMode({ skills: ['skills/outline/SKILL.md', 'skills/plan/SKILL.md'] }),
    )
    expect(snapshot.skills).toEqual([
      'skills/outline/SKILL.md',
      'skills/plan/SKILL.md',
    ])
    expect(Object.isFrozen(snapshot.skills)).toBe(true)
  })

  it('rejects a flat skill file name that is not a package entry', () => {
    expect(() =>
      snapshotModuleChatMode(baseMode({ skills: ['outline-skill.md'] })),
    ).toThrow(/must be a package path ending in "SKILL\.md"/)
  })

  it('rejects a package path whose entry file is not SKILL.md', () => {
    expect(() =>
      snapshotModuleChatMode(baseMode({ skills: ['skills/outline/index.md'] })),
    ).toThrow(/must be a package path ending in "SKILL\.md"/)
  })

  it('rejects a skill path with unsafe characters', () => {
    expect(() =>
      snapshotModuleChatMode(baseMode({ skills: ['../escape/SKILL.md'] })),
    ).toThrow(/must be a safe relative artifact path/)
  })

  it('rejects a non-string skill entry', () => {
    expect(() =>
      snapshotModuleChatMode(baseMode({ skills: [42 as unknown as string] })),
    ).toThrow(/must be a string/)
  })

  it('rejects duplicate skill paths', () => {
    expect(() =>
      snapshotModuleChatMode(
        baseMode({
          skills: ['skills/outline/SKILL.md', 'skills/outline/SKILL.md'],
        }),
      ),
    ).toThrow(/is duplicated/)
  })

  it('rejects two packages that would claim the same vault directory', () => {
    expect(() =>
      snapshotModuleChatMode(
        baseMode({
          skills: ['skills/outline/SKILL.md', 'extra/outline/SKILL.md'],
        }),
      ),
    ).toThrow(/package "outline" is declared twice/)
  })

  // Distinct manifest paths, one projected directory on macOS and Windows.
  it('rejects two packages that collide only on a case-insensitive filesystem', () => {
    expect(() =>
      snapshotModuleChatMode(
        baseMode({
          skills: ['skills/outline/SKILL.md', 'extra/Outline/SKILL.md'],
        }),
      ),
    ).toThrow(/package "Outline" is declared twice/)
  })

  it(`rejects more than ${MAX_MODULE_CHAT_MODE_SKILLS} skills`, () => {
    const skills = Array.from(
      { length: MAX_MODULE_CHAT_MODE_SKILLS + 1 },
      (_, index) => `skills/skill-${index}/SKILL.md`,
    )
    expect(() => snapshotModuleChatMode(baseMode({ skills }))).toThrow(
      new RegExp(`must not exceed ${MAX_MODULE_CHAT_MODE_SKILLS}`),
    )
  })
})

describe('ModuleChatModeRegistry', () => {
  it('publishes an entry with default availability and notifies subscribers', () => {
    const registry = new ModuleChatModeRegistry()
    const listener = jest.fn()
    registry.subscribe(listener)

    registry.add('learning', snapshotModuleChatMode(baseMode()))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(registry.getSnapshot()).toEqual([
      {
        fullModeId: 'module:learning:chat',
        moduleId: 'learning',
        mode: expect.objectContaining({ id: 'chat' }),
        serverName: 'module-mode-learning-chat',
        availability: { status: 'available' },
      },
    ])
    expect(Object.isFrozen(registry.getSnapshot())).toBe(true)
    expect(Object.isFrozen(registry.getSnapshot()[0])).toBe(true)
  })

  it('removes only the targeted module/mode pair', () => {
    const registry = new ModuleChatModeRegistry()
    registry.add('learning', snapshotModuleChatMode(baseMode({ id: 'chat' })))
    registry.add('other', snapshotModuleChatMode(baseMode({ id: 'chat' })))

    registry.remove('learning', 'chat')

    expect(registry.getSnapshot().map((entry) => entry.fullModeId)).toEqual([
      'module:other:chat',
    ])
  })

  it('remove is a no-op (no notification) when the entry does not exist', () => {
    const registry = new ModuleChatModeRegistry()
    const listener = jest.fn()
    registry.subscribe(listener)

    registry.remove('learning', 'chat')

    expect(listener).not.toHaveBeenCalled()
  })

  it('setAvailability updates status and notifies once, and no-ops when unchanged', () => {
    const registry = new ModuleChatModeRegistry()
    registry.add('learning', snapshotModuleChatMode(baseMode()))
    const listener = jest.fn()
    registry.subscribe(listener)

    registry.setAvailability('module:learning:chat', {
      status: 'unavailable',
      reason: 'name collision',
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(registry.getSnapshot()[0].availability).toEqual({
      status: 'unavailable',
      reason: 'name collision',
    })

    // Same status/reason again: no-op.
    registry.setAvailability('module:learning:chat', {
      status: 'unavailable',
      reason: 'name collision',
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('setAvailability on an unknown full mode id is a no-op', () => {
    const registry = new ModuleChatModeRegistry()
    const listener = jest.fn()
    registry.subscribe(listener)

    registry.setAvailability('module:learning:chat', { status: 'available' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('subscribe returns an unsubscribe function', () => {
    const registry = new ModuleChatModeRegistry()
    const listener = jest.fn()
    const unsubscribe = registry.subscribe(listener)
    unsubscribe()

    registry.add('learning', snapshotModuleChatMode(baseMode()))

    expect(listener).not.toHaveBeenCalled()
  })

  it('clear removes every entry and notifies once', () => {
    const registry = new ModuleChatModeRegistry()
    registry.add('learning', snapshotModuleChatMode(baseMode({ id: 'chat' })))
    registry.add('learning', snapshotModuleChatMode(baseMode({ id: 'quiz' })))
    const listener = jest.fn()
    registry.subscribe(listener)

    registry.clear()

    expect(registry.getSnapshot()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('sorts the snapshot by full mode id', () => {
    const registry = new ModuleChatModeRegistry()
    registry.add('zeta', snapshotModuleChatMode(baseMode({ id: 'chat' })))
    registry.add('alpha', snapshotModuleChatMode(baseMode({ id: 'chat' })))

    expect(registry.getSnapshot().map((entry) => entry.fullModeId)).toEqual([
      'module:alpha:chat',
      'module:zeta:chat',
    ])
  })
})

describe('MAX_MODULE_CHAT_MODES_PER_MODULE', () => {
  it('is 4, matching the design cap', () => {
    expect(MAX_MODULE_CHAT_MODES_PER_MODULE).toBe(4)
  })
})

describe('createModuleChatModeToolServer', () => {
  it('builds an in-process server that dispatches to the declared tool handlers', async () => {
    const handler = jest.fn(async (input: Record<string, unknown>) => ({
      content: JSON.stringify(input),
    }))
    const server = createModuleChatModeToolServer([
      {
        name: 'echo',
        description: 'Echoes input.',
        inputSchema: { type: 'object', properties: {} },
        handler,
      },
    ])

    expect(server.listTools()).toEqual([
      {
        name: 'echo',
        description: 'Echoes input.',
        inputSchema: { type: 'object', properties: {} },
      },
    ])

    const result = await server.callTool({
      toolName: 'echo',
      args: { hello: 'world' },
      signal: new AbortController().signal,
    })

    expect(result).toEqual({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: JSON.stringify({ hello: 'world' }) },
    })
    expect(handler).toHaveBeenCalledWith({ hello: 'world' })
  })
})
