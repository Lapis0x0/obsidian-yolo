import { migrateFrom76To77 } from './76_to_77'

describe('76_to_77', () => {
  it('enables multiple Tab completion candidates by default', () => {
    expect(
      migrateFrom76To77({
        version: 76,
        continuationOptions: { tabCompletionOptions: {} },
      }),
    ).toMatchObject({
      version: 77,
      continuationOptions: {
        tabCompletionOptions: { multipleCandidatesEnabled: true },
      },
    })
  })

  it('preserves an explicit disabled preference', () => {
    expect(
      migrateFrom76To77({
        version: 76,
        continuationOptions: {
          tabCompletionOptions: { multipleCandidatesEnabled: false },
        },
      }),
    ).toMatchObject({
      version: 77,
      continuationOptions: {
        tabCompletionOptions: { multipleCandidatesEnabled: false },
      },
    })
  })

  it('moves legacy per-tool disclosure modes to their MCP server', () => {
    const result = migrateFrom76To77({
      version: 76,
      assistants: [
        {
          id: 'agent',
          toolPreferences: {
            remote__read: {
              enabled: true,
              approvalMode: 'require_approval',
              disclosureMode: 'always',
            },
            remote__write: {
              enabled: false,
              disclosureMode: 'on_demand',
            },
            yolo_local__fs_read: {
              enabled: true,
              disclosureMode: 'always',
            },
          },
          toolServerPreferences: {
            remote: { approvalMode: 'full_access' },
          },
        },
      ],
    })

    expect(result.assistants).toEqual([
      {
        id: 'agent',
        toolPreferences: {
          remote__read: {
            enabled: true,
            approvalMode: 'require_approval',
          },
          remote__write: { enabled: false },
          yolo_local__fs_read: { enabled: true },
        },
        toolServerPreferences: {
          remote: {
            approvalMode: 'full_access',
            disclosureMode: 'on_demand',
          },
        },
      },
    ])
  })

  it('keeps an already migrated server disclosure mode authoritative', () => {
    const result = migrateFrom76To77({
      version: 76,
      assistants: [
        {
          toolPreferences: {
            remote__read: { disclosureMode: 'on_demand' },
          },
          toolServerPreferences: {
            remote: { disclosureMode: 'always' },
          },
        },
      ],
    })

    expect(result.assistants).toEqual([
      {
        toolPreferences: { remote__read: {} },
        toolServerPreferences: { remote: { disclosureMode: 'always' } },
      },
    ])
  })
})
