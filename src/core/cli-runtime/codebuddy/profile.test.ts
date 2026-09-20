import { codebuddyAgentProfile } from './profile'

describe('codebuddyAgentProfile.resolveSessionModeId', () => {
  const resolve = (mode: 'agent' | 'plan', yoloEnabled: boolean) =>
    codebuddyAgentProfile.resolveSessionModeId?.({ mode, yoloEnabled })

  /**
   * The ids below are CodeBuddy's own — the same vocabulary its
   * `--permission-mode` flag takes, advertised per session as ACP modes.
   */
  it('puts Agent mode on the edits-approved policy', () => {
    expect(resolve('agent', false)).toBe('acceptEdits')
  })

  it('puts YOLO on the bypass policy, not the fullAccess one', () => {
    expect(resolve('agent', true)).toBe('bypassPermissions')
  })

  it('maps Plan mode to the agent’s own plan policy', () => {
    expect(resolve('plan', false)).toBe('plan')
  })

  it('keeps Plan mode on plan even if a caller passes YOLO alongside it', () => {
    expect(resolve('plan', true)).toBe('plan')
  })
})

describe('codebuddyAgentProfile', () => {
  it('compacts through the agent’s own slash command', () => {
    expect(codebuddyAgentProfile.compactCommand).toBe('/compact')
  })

  /**
   * Every method CodeBuddy advertises finishes in a browser or on a phone,
   * so the runtime never calls `authenticate` and rides on the credential
   * the CLI already cached.
   */
  it('declares no authentication policy', () => {
    expect(codebuddyAgentProfile.selectAuthMethod).toBeUndefined()
  })
})
