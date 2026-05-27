import { migrateFrom61To62 } from './61_to_62'

describe('migrateFrom61To62', () => {
  it('drops orphan toolPreferences whose server is no longer in mcp.servers', () => {
    const result = migrateFrom61To62({
      version: 61,
      mcp: { servers: [{ id: 'github', name: 'github' }] },
      assistants: [
        {
          id: 'a1',
          toolPreferences: {
            yolo_local__fs_read: { enabled: true },
            github__list_repos: { enabled: true },
            Gemini__click: { enabled: true },
            Gemini__get_all_tabs: { enabled: true },
          },
          enabledToolNames: [
            'yolo_local__fs_read',
            'github__list_repos',
            'Gemini__click',
          ],
        },
      ],
    })

    expect(result.version).toBe(62)
    const assistant = (result.assistants as Array<Record<string, unknown>>)[0]
    expect(assistant.toolPreferences).toEqual({
      yolo_local__fs_read: { enabled: true },
      github__list_repos: { enabled: true },
    })
    expect(assistant.enabledToolNames).toEqual([
      'yolo_local__fs_read',
      'github__list_repos',
    ])
  })

  it('keeps yolo_local entries even when mcp.servers is empty', () => {
    const result = migrateFrom61To62({
      version: 61,
      mcp: { servers: [] },
      assistants: [
        {
          toolPreferences: {
            yolo_local__fs_read: { enabled: true },
            Ghost__do_thing: { enabled: true },
          },
        },
      ],
    })

    const assistant = (result.assistants as Array<Record<string, unknown>>)[0]
    expect(assistant.toolPreferences).toEqual({
      yolo_local__fs_read: { enabled: true },
    })
  })

  it('drops keys that do not parse as serverName__toolName', () => {
    const result = migrateFrom61To62({
      version: 61,
      mcp: { servers: [] },
      assistants: [
        {
          toolPreferences: {
            'bogus-no-delimiter': { enabled: true },
          },
        },
      ],
    })

    const assistant = (result.assistants as Array<Record<string, unknown>>)[0]
    expect(assistant.toolPreferences).toEqual({})
  })

  it('is a no-op when there are no assistants', () => {
    const result = migrateFrom61To62({ version: 61 })
    expect(result.version).toBe(62)
  })
})
