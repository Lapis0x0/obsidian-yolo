import { migrateFrom58To59 } from './58_to_59'

describe('Migration from v58 to v59', () => {
  it('seeds default chatExport when absent', () => {
    const oldSettings = { version: 58 }
    const result = migrateFrom58To59(oldSettings)
    expect(result.version).toBe(59)
    expect(result.chatExport).toEqual({
      followUniqueNote: false,
      folder: '',
      filenameTemplate: '{{title}} - {{date}}',
      appendTitleWhenFollowing: true,
      conflictStrategy: 'suffix',
    })
  })

  it('preserves an already-set chatExport object', () => {
    const oldSettings = {
      version: 58,
      chatExport: {
        followUniqueNote: true,
        folder: 'Inbox/Chats',
        filenameTemplate: 'Chat_{{datetime}}',
        appendTitleWhenFollowing: false,
        conflictStrategy: 'overwrite',
      },
    }
    const result = migrateFrom58To59(oldSettings)
    expect(result.version).toBe(59)
    expect(result.chatExport).toEqual(oldSettings.chatExport)
  })

  it('overwrites a non-object chatExport value with defaults', () => {
    const oldSettings = { version: 58, chatExport: 'invalid' }
    const result = migrateFrom58To59(oldSettings)
    expect(result.chatExport).toEqual({
      followUniqueNote: false,
      folder: '',
      filenameTemplate: '{{title}} - {{date}}',
      appendTitleWhenFollowing: true,
      conflictStrategy: 'suffix',
    })
  })

  it('keeps unrelated fields untouched', () => {
    const oldSettings = {
      version: 58,
      yolo: { baseDir: 'MyVault' },
      providers: [{ id: 'openai' }],
    }
    const result = migrateFrom58To59(oldSettings)
    expect(result.yolo).toEqual({ baseDir: 'MyVault' })
    expect(result.providers).toEqual([{ id: 'openai' }])
  })
})
