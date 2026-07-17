import type { LearningGenerationHost } from '../../core/learning/generation/host'

import type { LearningUiHost } from './LearningUiHost'

export function createLearningGenerationHost(
  host: LearningUiHost,
): LearningGenerationHost {
  return {
    app: host.app,
    agent: host.generationAgent,
    isDebugEnabled: host.isGenerationDebugEnabled,
  }
}
