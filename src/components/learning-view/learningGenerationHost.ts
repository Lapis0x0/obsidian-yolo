import type { LearningGenerationHost } from '../../core/learning/generation/host'

import type { LearningUiHost } from './LearningUiHost'

export function createLearningGenerationHost(
  host: LearningUiHost,
): LearningGenerationHost {
  return {
    vault: host.vault,
    vaultWriter: host.vaultWriter,
    agent: host.generationAgent,
    isDebugEnabled: host.isGenerationDebugEnabled,
  }
}
