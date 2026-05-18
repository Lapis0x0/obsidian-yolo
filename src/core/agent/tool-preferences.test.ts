import { getLocalFileToolServerName } from '../mcp/localFileTools'
import { getToolName } from '../mcp/tool-name-utils'

import {
  getAssistantToolApprovalMode,
  getDefaultApprovalModeForTool,
} from './tool-preferences'

describe('tool preferences', () => {
  it('defaults run_model_task to require_approval but allows agent auto-approval', () => {
    const fullName = getToolName(getLocalFileToolServerName(), 'run_model_task')

    expect(getDefaultApprovalModeForTool(fullName)).toBe('require_approval')
    expect(
      getAssistantToolApprovalMode(
        {
          toolPreferences: {
            [fullName]: {
              enabled: true,
              approvalMode: 'full_access',
            },
          },
        },
        fullName,
      ),
    ).toBe('full_access')
  })
})
