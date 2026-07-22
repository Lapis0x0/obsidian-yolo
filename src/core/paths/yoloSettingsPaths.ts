import type { YoloSettings } from '../../settings/schema/setting.types'

import { getYoloLogsDir } from './yoloPaths'

const DEBUG_LOG_PATTERN_SUFFIXES = [
  '/**',
  '/*',
  '/**/*.md',
  '/*.md',
  '/',
] as const

/**
 * Keep the optional explicit debug-log RAG exclusion aligned with a local
 * managed-root move. Other patterns are user-owned and remain untouched.
 */
export const rebaseYoloDebugLogExclusions = (
  settings: YoloSettings,
  sourceBaseDir: string,
  targetBaseDir: string,
  previousSettings?: YoloSettings,
): YoloSettings => {
  const previousPatterns = previousSettings?.ragOptions.excludePatterns
  if (
    previousPatterns &&
    (settings.ragOptions.excludePatterns.length !== previousPatterns.length ||
      settings.ragOptions.excludePatterns.some(
        (pattern, index) => pattern !== previousPatterns[index],
      ))
  ) {
    return settings
  }

  const sourceLogsDir = getYoloLogsDir({ yolo: { baseDir: sourceBaseDir } })
  const targetLogsDir = getYoloLogsDir({ yolo: { baseDir: targetBaseDir } })
  let changed = false
  const excludePatterns = settings.ragOptions.excludePatterns.map((pattern) => {
    for (const suffix of DEBUG_LOG_PATTERN_SUFFIXES) {
      if (pattern === `${sourceLogsDir}${suffix}`) {
        changed = true
        return `${targetLogsDir}${suffix}`
      }
    }
    return pattern
  })

  if (!changed) return settings
  return {
    ...settings,
    ragOptions: {
      ...settings.ragOptions,
      excludePatterns,
    },
  }
}
