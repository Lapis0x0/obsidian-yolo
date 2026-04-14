import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { getToolName } from '../../../core/mcp/tool-name-utils'

import {
  normalizeToolPreferencesForPersistence,
  normalizeToolSelectionForPersistence,
} from './agentToolPersistence'

describe('agentToolPersistence', () => {
  const builtinToolName = getToolName(getLocalFileToolServerName(), 'fs_read')
  const remoteToolName = getToolName('remote_mcp', 'search_docs')
  const unknownBuiltinToolName = getToolName(
    getLocalFileToolServerName(),
    'removed_tool',
  )

  it('keeps remote tool preferences when the MCP server is temporarily unavailable', () => {
    expect(
      normalizeToolPreferencesForPersistence(
        {
          [builtinToolName]: { enabled: true, approvalMode: 'full_access' },
          [remoteToolName]: {
            enabled: true,
            approvalMode: 'require_approval',
          },
        },
        [{ name: builtinToolName } as never],
      ),
    ).toEqual({
      [builtinToolName]: { enabled: true, approvalMode: 'full_access' },
      [remoteToolName]: {
        enabled: true,
        approvalMode: 'require_approval',
      },
    })
  })

  it('drops unknown built-in tool preferences during persistence', () => {
    expect(
      normalizeToolPreferencesForPersistence(
        {
          [unknownBuiltinToolName]: {
            enabled: true,
            approvalMode: 'require_approval',
          },
          [remoteToolName]: {
            enabled: true,
            approvalMode: 'require_approval',
          },
        },
        [],
      ),
    ).toEqual({
      [remoteToolName]: {
        enabled: true,
        approvalMode: 'require_approval',
      },
    })
  })

  it('keeps remote enabled tool selections when the MCP server is temporarily unavailable', () => {
    expect(
      normalizeToolSelectionForPersistence(
        [builtinToolName, remoteToolName, unknownBuiltinToolName],
        [{ name: builtinToolName } as never],
      ),
    ).toEqual([builtinToolName, remoteToolName])
  })
})
