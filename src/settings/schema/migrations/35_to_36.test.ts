import { migrateFrom35To36 } from './35_to_36'

describe('migrateFrom35To36', () => {
  it('adds toolPreferences for enabled agent tools', () => {
    const result = migrateFrom35To36({
      version: 35,
      assistants: [
        {
          id: 'agent-1',
          enabledToolNames: ['yolo_local__fs_read', 'server__tool_a'],
        },
      ],
    })

    expect(result).toEqual({
      version: 36,
      assistants: [
        {
          id: 'agent-1',
          enabledToolNames: ['yolo_local__fs_read', 'server__tool_a'],
          toolPreferences: {
            yolo_local__fs_read: {
              enabled: true,
              approvalMode: 'full_access',
            },
            server__tool_a: {
              enabled: true,
              approvalMode: 'require_approval',
            },
          },
        },
      ],
    })
  })

  it('resets approval modes with the new defaults while keeping enabled state', () => {
    const result = migrateFrom35To36({
      version: 35,
      assistants: [
        {
          id: 'agent-1',
          enabledToolNames: ['yolo_local__fs_move', 'server__tool_b'],
          toolPreferences: {
            yolo_local__fs_read: {
              enabled: false,
              approvalMode: 'require_approval',
            },
            yolo_local__fs_move: {
              enabled: true,
              approvalMode: 'full_access',
            },
          },
        },
      ],
    })

    expect(result).toEqual({
      version: 36,
      assistants: [
        {
          id: 'agent-1',
          enabledToolNames: ['yolo_local__fs_move', 'server__tool_b'],
          toolPreferences: {
            yolo_local__fs_read: {
              enabled: false,
              approvalMode: 'full_access',
            },
            yolo_local__fs_move: {
              enabled: true,
              approvalMode: 'require_approval',
            },
            server__tool_b: {
              enabled: true,
              approvalMode: 'require_approval',
            },
          },
        },
      ],
    })
  })

  it('resets existing MCP tools to require approval', () => {
    const result = migrateFrom35To36({
      version: 35,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            'context7__resolve-library-id': {
              enabled: true,
              approvalMode: 'full_access',
            },
          },
        },
      ],
    })

    expect(result).toEqual({
      version: 36,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            'context7__resolve-library-id': {
              enabled: true,
              approvalMode: 'require_approval',
            },
          },
        },
      ],
    })
  })

  it('maps legacy useObsidianRequestUrl to requestTransportMode', () => {
    const result = migrateFrom35To36({
      version: 35,
      providers: [
        {
          type: 'anthropic',
          id: 'anthropic',
          additionalSettings: {
            useObsidianRequestUrl: true,
          },
        },
        {
          type: 'openai-compatible',
          id: 'openai-compatible',
          additionalSettings: {
            useObsidianRequestUrl: false,
            noStainless: true,
          },
        },
      ],
    })

    expect(result.version).toBe(36)
    expect(result.providers).toEqual([
      {
        type: 'anthropic',
        id: 'anthropic',
        additionalSettings: {
          useObsidianRequestUrl: true,
          requestTransportMode: 'obsidian',
        },
      },
      {
        type: 'openai-compatible',
        id: 'openai-compatible',
        additionalSettings: {
          useObsidianRequestUrl: false,
          noStainless: true,
          requestTransportMode: 'browser',
        },
      },
    ])
  })

  it('keeps providers that already define requestTransportMode', () => {
    const result = migrateFrom35To36({
      version: 35,
      providers: [
        {
          type: 'anthropic',
          id: 'anthropic',
          additionalSettings: {
            requestTransportMode: 'auto',
            useObsidianRequestUrl: true,
          },
        },
      ],
    })

    expect(result.providers).toEqual([
      {
        type: 'anthropic',
        id: 'anthropic',
        additionalSettings: {
          requestTransportMode: 'auto',
          useObsidianRequestUrl: true,
        },
      },
    ])
  })
})
