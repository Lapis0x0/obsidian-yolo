import { DEFAULT_CHAT_QUICK_ACCESS_ENTRIES } from '../../chatQuickAccess'

import { migrateFrom74To75 } from './74_to_75'

describe('migrateFrom74To75', () => {
  it('seeds the default Chat quick access entries', () => {
    const result = migrateFrom74To75({ version: 74, chatOptions: {} })

    expect(result).toMatchObject({
      version: 75,
      chatOptions: {
        quickAccessEntries: DEFAULT_CHAT_QUICK_ACCESS_ENTRIES,
      },
    })
  })

  it('preserves an existing customized order, including an empty list', () => {
    const quickAccessEntries = [
      { type: 'snippet', id: 'review' },
      { type: 'skill', name: 'skill-creator' },
    ]
    const customized = migrateFrom74To75({
      version: 74,
      chatOptions: { quickAccessEntries },
    })
    const empty = migrateFrom74To75({
      version: 74,
      chatOptions: { quickAccessEntries: [] },
    })

    expect(
      (customized.chatOptions as Record<string, unknown>).quickAccessEntries,
    ).toEqual(quickAccessEntries)
    expect(
      (empty.chatOptions as Record<string, unknown>).quickAccessEntries,
    ).toEqual([])
  })
})
