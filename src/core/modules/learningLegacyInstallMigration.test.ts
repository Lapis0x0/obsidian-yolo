jest.mock('obsidian', () => ({
  normalizePath: (path: string) =>
    path.replace(/\\/g, '/').replace(/\/{2,}/g, '/'),
}))

import {
  type LearningIntentEnableIfAbsent,
  migrateLearningLegacyInstallIntent,
} from './learningLegacyInstallMigration'

function createHarness(paths: readonly string[] = []) {
  const existing = new Set(paths)
  const enableIfAbsent: jest.MockedFunction<LearningIntentEnableIfAbsent> =
    jest.fn(async (_moduleId: string) => 'created')
  return {
    enableIfAbsent,
    options: {
      adapter: { exists: async (path: string) => existing.has(path) },
      settings: { yolo: { baseDir: 'Custom/YOLO' } },
      legacySettings: undefined as unknown,
      enableIfAbsent,
    },
  }
}

describe('migrateLearningLegacyInstallIntent', () => {
  it('enables a legacy user who confirmed the beta notice', async () => {
    const harness = createHarness()

    await expect(
      migrateLearningLegacyInstallIntent({
        ...harness.options,
        legacySettings: { betaNoticeAcknowledged: true },
      }),
    ).resolves.toBe('enabled')
    expect(harness.enableIfAbsent).toHaveBeenCalledWith('learning')
  })

  it.each([
    'Custom/YOLO/learning',
    'Custom/YOLO/.yolo_json_db/learning-srs',
    'Custom/YOLO/.yolo_json_db/anki-import-journals',
    '.smtcmp_json_db/learning-srs',
    '.smtcmp_json_db/anki-import-journals',
  ])('recognizes persisted Learning data at %s', async (path) => {
    const harness = createHarness([path])

    await expect(
      migrateLearningLegacyInstallIntent(harness.options),
    ).resolves.toBe('enabled')
  })

  it('leaves a never-used installation without module intent', async () => {
    const harness = createHarness()

    await expect(
      migrateLearningLegacyInstallIntent({
        ...harness.options,
        legacySettings: {
          modelId: 'provider/automatically-normalized-default',
          betaNoticeAcknowledged: false,
        },
      }),
    ).resolves.toBe('not-used')
    expect(harness.enableIfAbsent).not.toHaveBeenCalled()
  })

  it('preserves an explicit module decision', async () => {
    const harness = createHarness()
    harness.enableIfAbsent.mockResolvedValue('already-present')

    await expect(
      migrateLearningLegacyInstallIntent({
        ...harness.options,
        legacySettings: { betaNoticeAcknowledged: true },
      }),
    ).resolves.toBe('already-decided')
  })
})
