import {
  MAX_MODULE_TOOL_SETS_PER_MODULE,
  ModuleToolSetRegistry,
  buildModuleToolSetServerName,
  snapshotModuleToolSet,
} from './moduleToolSetRegistry'
import type { YoloModuleToolSetV1 } from './types'

const baseToolSet = (
  overrides: Partial<YoloModuleToolSetV1> = {},
): YoloModuleToolSetV1 => ({
  id: 'whiteboard',
  label: { en: 'Whiteboard tools' },
  description: { en: 'Edit boards' },
  category: 'vault',
  tools: [
    {
      name: 'edit_board',
      description: 'Edit a board',
      inputSchema: { type: 'object' },
      handler: () => ({ content: 'ok' }),
    },
  ],
  ...overrides,
})

describe('snapshotModuleToolSet', () => {
  it('freezes a valid declaration', () => {
    const snapshot = snapshotModuleToolSet(baseToolSet())
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot.id).toBe('whiteboard')
    expect(snapshot.tools).toHaveLength(1)
  })

  it('rejects an id that is not a legal server name segment', () => {
    // The id becomes `yolo_<id>`, which rides the model-facing catalog — a
    // hyphen or capital there would produce a name the tool-name parser and
    // the provider disagree about.
    for (const id of ['Whiteboard', 'white-board', '1board', 'white board']) {
      expect(() => snapshotModuleToolSet(baseToolSet({ id }))).toThrow(
        /must match/,
      )
    }
  })

  it('rejects a category the host cannot render', () => {
    expect(() =>
      snapshotModuleToolSet(
        baseToolSet({
          category: 'nowhere' as YoloModuleToolSetV1['category'],
        }),
      ),
    ).toThrow(/category is invalid/)
  })

  it('rejects an empty tool list', () => {
    // A set with no tools is a catalog group heading with nothing under it.
    expect(() => snapshotModuleToolSet(baseToolSet({ tools: [] }))).toThrow(
      /at least one tool/,
    )
  })

  it('rejects duplicate tool names within the set', () => {
    const tool = baseToolSet().tools[0]
    expect(() =>
      snapshotModuleToolSet(baseToolSet({ tools: [tool, tool] })),
    ).toThrow(/duplicated/)
  })

  it('rejects a tool the shared agent-tool validation refuses', () => {
    expect(() =>
      snapshotModuleToolSet(
        baseToolSet({
          tools: [
            {
              name: 'Bad-Name',
              description: 'x',
              inputSchema: { type: 'object' },
              handler: () => ({ content: 'ok' }),
            },
          ],
        }),
      ),
    ).toThrow()
  })
})

describe('ModuleToolSetRegistry', () => {
  it('addresses a set as yolo_<id>', () => {
    expect(buildModuleToolSetServerName('whiteboard')).toBe('yolo_whiteboard')
  })

  it('publishes a snapshot and notifies subscribers', () => {
    const registry = new ModuleToolSetRegistry()
    const listener = jest.fn()
    registry.subscribe(listener)

    registry.add('whiteboard', snapshotModuleToolSet(baseToolSet()))

    expect(listener).toHaveBeenCalledTimes(1)
    const snapshot = registry.getSnapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].serverName).toBe('yolo_whiteboard')
    expect(snapshot[0].availability).toEqual({ status: 'available' })
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('refuses an id another module already owns', () => {
    const registry = new ModuleToolSetRegistry()
    registry.add('whiteboard', snapshotModuleToolSet(baseToolSet()))
    expect(() =>
      registry.add('learning', snapshotModuleToolSet(baseToolSet())),
    ).toThrow(/already registered by module "whiteboard"/)
    expect(registry.getSnapshot()).toHaveLength(1)
  })

  it('lets the owning module re-register its own id', () => {
    const registry = new ModuleToolSetRegistry()
    registry.add('whiteboard', snapshotModuleToolSet(baseToolSet()))
    registry.add(
      'whiteboard',
      snapshotModuleToolSet(baseToolSet({ label: { en: 'Renamed' } })),
    )
    expect(registry.getSnapshot()).toHaveLength(1)
    expect(registry.getSnapshot()[0].set.label).toEqual({ en: 'Renamed' })
  })

  it('only lets the owning module remove a set', () => {
    const registry = new ModuleToolSetRegistry()
    registry.add('whiteboard', snapshotModuleToolSet(baseToolSet()))

    registry.remove('learning', 'whiteboard')
    expect(registry.getSnapshot()).toHaveLength(1)

    registry.remove('whiteboard', 'whiteboard')
    expect(registry.getSnapshot()).toHaveLength(0)
  })

  it('reports a registration outcome without churning identical ones', () => {
    const registry = new ModuleToolSetRegistry()
    registry.add('whiteboard', snapshotModuleToolSet(baseToolSet()))
    const listener = jest.fn()
    registry.subscribe(listener)

    registry.setAvailability('whiteboard', { status: 'available' })
    expect(listener).not.toHaveBeenCalled()

    registry.setAvailability('whiteboard', {
      status: 'unavailable',
      reason: 'name taken',
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(registry.getSnapshot()[0].availability).toEqual({
      status: 'unavailable',
      reason: 'name taken',
    })
  })

  it('caps how many sets one module may own', () => {
    expect(MAX_MODULE_TOOL_SETS_PER_MODULE).toBeGreaterThan(0)
  })
})
