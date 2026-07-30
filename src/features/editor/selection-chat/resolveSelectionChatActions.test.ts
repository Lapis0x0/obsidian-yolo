import type { YoloSettings } from '../../../settings/schema/setting.types'

import { resolveSelectionChatActions } from './resolveSelectionChatActions'

const t = (_key: string, fallback?: string) => fallback ?? _key

function settingsWithActions(
  selectionChatActions?: NonNullable<
    YoloSettings['continuationOptions']['selectionChatActions']
  >,
): YoloSettings {
  return {
    continuationOptions: { selectionChatActions },
  } as YoloSettings
}

describe('resolveSelectionChatActions', () => {
  test('uses the shared catalog order for default actions', () => {
    const actions = resolveSelectionChatActions(settingsWithActions(), t)

    expect(actions.map((action) => action.id)).toEqual([
      'custom-rewrite',
      'custom-ask',
      'add-to-sidebar',
      'explain',
      'suggest',
      'translate-to-chinese',
    ])
  })

  test('backfills missing fixed actions without overriding stored order', () => {
    const actions = resolveSelectionChatActions(
      settingsWithActions([
        {
          id: 'custom-action',
          label: 'Custom',
          instruction: 'Do it',
          enabled: true,
        },
      ]),
      t,
    )

    expect(actions.map((action) => action.id)).toEqual([
      'custom-rewrite',
      'custom-ask',
      'add-to-sidebar',
      'custom-action',
    ])
  })

  test('drops the legacy adjust-length quick action', () => {
    const actions = resolveSelectionChatActions(
      settingsWithActions([
        {
          id: 'adjust-length',
          label: '',
          instruction: '',
          enabled: false,
        },
      ]),
      t,
    )

    expect(actions.map((action) => action.id)).not.toContain('adjust-length')
  })
})
