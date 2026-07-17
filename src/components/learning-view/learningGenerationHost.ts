import type {
  LearningGenerationCapability,
  LearningGenerationHost,
} from '../../core/learning/generation/host'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import type YoloPlugin from '../../main'

const localFileToolName = (name: string) =>
  getToolName(getLocalFileToolServerName(), name)

const TOOL_NAMES_BY_CAPABILITY: Record<LearningGenerationCapability, string[]> =
  {
    none: [],
    'readonly-vault': [
      localFileToolName('fs_read'),
      localFileToolName('fs_list'),
    ],
    'edit-vault': [
      localFileToolName('fs_read'),
      localFileToolName('fs_list'),
      localFileToolName('fs_edit'),
    ],
  }

export function createLearningGenerationHost(
  plugin: YoloPlugin,
): LearningGenerationHost {
  return {
    app: plugin.app,
    agent: {
      stream: ({ capability, ...request }) =>
        plugin.agent.stream({
          ...request,
          tools: { allowedToolNames: TOOL_NAMES_BY_CAPABILITY[capability] },
        }),
    },
  }
}
