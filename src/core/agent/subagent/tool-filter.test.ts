import { getLocalFileToolServerName } from '../../mcp/localFileTools'
import { getToolName } from '../../mcp/tool-name-utils'

import { SUBAGENT_BLOCKED_TOOL_SHORT_NAMES } from './constants'
import {
  filterAllowedToolsForSubagent,
  isSubagentBlockedToolName,
} from './tool-filter'

describe('subagent tool-filter', () => {
  it('blocks recursive and interactive delegation tools by FQN', () => {
    for (const shortName of SUBAGENT_BLOCKED_TOOL_SHORT_NAMES) {
      const fqn = getToolName(getLocalFileToolServerName(), shortName)
      expect(isSubagentBlockedToolName(fqn)).toBe(true)
    }
  })

  it('filters parent allowlist without blanket fs bans', () => {
    const fsEdit = getToolName(getLocalFileToolServerName(), 'fs_edit')
    const subagent = getToolName(
      getLocalFileToolServerName(),
      'delegate_subagent',
    )
    const parent = [fsEdit, subagent, 'mcp_server__remote_tool']

    const filtered = filterAllowedToolsForSubagent(parent)
    expect(filtered).toEqual([fsEdit, 'mcp_server__remote_tool'])
  })

  it('treats a missing parent allowlist as no inherited tools', () => {
    expect(filterAllowedToolsForSubagent(undefined)).toEqual([])
  })
})
