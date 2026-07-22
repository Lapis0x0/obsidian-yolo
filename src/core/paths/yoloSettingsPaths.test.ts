import { parseYoloSettings } from '../../settings/schema/settings'

import { rebaseYoloDebugLogExclusions } from './yoloSettingsPaths'

describe('rebaseYoloDebugLogExclusions', () => {
  it('rebases only exact managed debug-log patterns', () => {
    const settings = parseYoloSettings({
      version: 77,
      ragOptions: {
        excludePatterns: [
          'YOLO/logs/**',
          'YOLO/logs/*',
          'YOLO/logs-archive/**',
          'Notes/**',
        ],
      },
    })

    expect(
      rebaseYoloDebugLogExclusions(settings, 'YOLO', 'Config/YOLO').ragOptions
        .excludePatterns,
    ).toEqual([
      'Config/YOLO/logs/**',
      'Config/YOLO/logs/*',
      'YOLO/logs-archive/**',
      'Notes/**',
    ])
  })

  it('preserves exclusions explicitly edited with the root', () => {
    const previousSettings = parseYoloSettings({
      version: 77,
      ragOptions: { excludePatterns: ['YOLO/logs/**', 'YOLO/logs/*'] },
    })
    const settings = parseYoloSettings({
      ...previousSettings,
      yolo: { baseDir: 'Config/YOLO' },
      ragOptions: { ...previousSettings.ragOptions, excludePatterns: [] },
    })

    expect(
      rebaseYoloDebugLogExclusions(
        settings,
        'YOLO',
        'Config/YOLO',
        previousSettings,
      ),
    ).toBe(settings)
  })
})
