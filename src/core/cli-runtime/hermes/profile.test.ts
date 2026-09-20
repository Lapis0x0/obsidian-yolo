import { hermesAgentProfile } from './profile'

describe('hermesAgentProfile.resolveSessionModeId', () => {
  const resolve = (mode: 'agent' | 'plan', yoloEnabled: boolean) =>
    hermesAgentProfile.resolveSessionModeId?.({ mode, yoloEnabled })

  /**
   * The ids below are Hermes's own (`acp_adapter/server.py`'s `_MODES`), and
   * each one selects a different edit-approval policy inside Hermes:
   * `accept_edits` auto-allows edits under the session cwd — the vault —
   * while still asking for anything outside it, and `dont_ask` drops that
   * boundary for the whole session.
   */
  it('puts Agent mode on the workspace-scoped policy', () => {
    expect(resolve('agent', false)).toBe('accept_edits')
  })

  it('puts YOLO on the session-wide policy', () => {
    expect(resolve('agent', true)).toBe('dont_ask')
  })

  it('keeps Plan mode asking, even if a caller passes YOLO alongside it', () => {
    expect(resolve('plan', false)).toBe('default')
    expect(resolve('plan', true)).toBe('default')
  })
})
