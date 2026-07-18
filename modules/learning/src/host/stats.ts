import type { LearningVaultReadApi } from '../domain/learningVaultReadApi'
import { scanProjects } from '../domain/projectScanner'
import type { LearningProjectSourcePort } from '../domain/stats/ports'

import type { LearningHostSettings } from './paths'

export function createHostLearningProjectSource(
  vault: LearningVaultReadApi,
  settings: LearningHostSettings,
): LearningProjectSourcePort {
  return {
    getLearningBaseDir: () => settings.getSnapshot().learningBaseDir,
    scanProjects: () =>
      scanProjects(vault, settings.getSnapshot().learningBaseDir),
  }
}
