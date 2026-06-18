import { getLocalFileToolServerName } from '../../mcp/localFileTools'
import { JS_SANDBOX_TOOL_NAME } from '../../mcp/jsSandboxTool'
import { getToolName } from '../../mcp/tool-name-utils'

import { SUBAGENT_BLOCKED_TOOL_SHORT_NAMES } from './constants'
import {
  filterAllowedToolsForSubagent,
  isSubagentBlockedToolName,
} from './tool-filter'

describe('subagent tool-filter', () => {
  const fsEdit = getToolName(getLocalFileToolServerName(), 'fs_edit')
  const delegate = getToolName(
    getLocalFileToolServerName(),
    'delegate_subagent',
  )
  const terminal = getToolName(
    getLocalFileToolServerName(),
    'terminal_command',
  )
  const askUser = getToolName(getLocalFileToolServerName(), 'ask_user_question')
  const jsEval = getToolName(getLocalFileToolServerName(), JS_SANDBOX_TOOL_NAME)

  it('blocks recursive and interactive delegation tools by FQN', () => {
    for (const shortName of SUBAGENT_BLOCKED_TOOL_SHORT_NAMES) {
      const fqn = getToolName(getLocalFileToolServerName(), shortName)
      expect(isSubagentBlockedToolName(fqn)).toBe(true)
    }
  })

  it('filters parent allowlist without blanket fs bans', () => {
    const parent = [
      fsEdit,
      delegate,
      terminal,
      askUser,
      'mcp_server__remote_tool',
    ]

    const filtered = filterAllowedToolsForSubagent(parent)
    expect(filtered).toEqual([fsEdit, terminal, 'mcp_server__remote_tool'])
  })

  it('treats a missing parent allowlist as no inherited tools', () => {
    expect(filterAllowedToolsForSubagent(undefined)).toEqual([])
  })

  describe('js sandbox high-risk capability gating', () => {
    it('does not block js_eval when no extension capability is enabled', () => {
      expect(
        isSubagentBlockedToolName(jsEval, { jsSandboxSettings: {} }),
      ).toBe(false)

      const filtered = filterAllowedToolsForSubagent(
        [fsEdit, jsEval, delegate],
        { jsSandboxSettings: {} },
      )
      expect(filtered).toEqual([fsEdit, jsEval])
    })

    it.each([
      ['allowFetch'],
      ['allowVaultRead'],
      ['allowDbQuery'],
      ['allowExternalScripts'],
    ] as const)(
      'blocks js_eval for subagents when %s is enabled',
      (capability) => {
        const settings = { [capability]: true }

        expect(
          isSubagentBlockedToolName(jsEval, { jsSandboxSettings: settings }),
        ).toBe(true)

        const filtered = filterAllowedToolsForSubagent(
          [fsEdit, jsEval, delegate],
          { jsSandboxSettings: settings },
        )
        expect(filtered).toEqual([fsEdit])
      },
    )

    it('treats missing jsSandboxSettings as no extension capability', () => {
      // Defensive default — runtime callers always pass settings, but the
      // helper must not silently grant js_eval if a future caller forgets.
      expect(isSubagentBlockedToolName(jsEval)).toBe(false)
      expect(filterAllowedToolsForSubagent([jsEval])).toEqual([jsEval])
    })

    it('still blocks baseline tools regardless of js sandbox settings', () => {
      const settings = { allowFetch: true }
      expect(
        isSubagentBlockedToolName(delegate, { jsSandboxSettings: settings }),
      ).toBe(true)
      expect(
        isSubagentBlockedToolName(askUser, { jsSandboxSettings: settings }),
      ).toBe(true)
    })
  })
})
