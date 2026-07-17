import { migrateFrom69To70 } from './69_to_70'

describe('migrateFrom69To70', () => {
  it('bumps version and removes legacy browser settings', () => {
    const result = migrateFrom69To70({
      version: 69,
      browser: {
        injectActivePageContext: true,
        retainLastViewedPage: true,
        injectSelectionMaxChars: 500,
      },
    })

    expect(result.version).toBe(70)
    expect(result.browser).toBeUndefined()
  })

  it('removes stale browser_read_page tool preferences from assistants', () => {
    const result = migrateFrom69To70({
      version: 69,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            yolo_local__browser_read_page: {
              enabled: true,
              approvalMode: 'require_approval',
              disclosureMode: 'always',
            },
            yolo_local__fs_read: {
              enabled: true,
              approvalMode: 'full_access',
              disclosureMode: 'always',
            },
          },
        },
      ],
    })

    const assistants = result.assistants as Array<Record<string, unknown>>
    const preferences = assistants[0].toolPreferences as Record<
      string,
      Record<string, unknown>
    >
    expect(preferences['yolo_local__browser_read_page']).toBeUndefined()
    expect(preferences['yolo_local__fs_read']).toEqual({
      enabled: true,
      approvalMode: 'full_access',
      disclosureMode: 'always',
    })
  })
})
