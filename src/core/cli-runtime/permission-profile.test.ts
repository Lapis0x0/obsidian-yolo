import {
  normalizeCliChatMode,
  resolveClaudePermissionMode,
  resolveCodexSandboxConfig,
} from './permission-profile'

describe('normalizeCliChatMode', () => {
  it('keeps valid modes and falls back otherwise', () => {
    expect(normalizeCliChatMode('agent')).toBe('agent')
    expect(normalizeCliChatMode('plan')).toBe('plan')
    expect(normalizeCliChatMode('ask')).toBe('agent')
    expect(normalizeCliChatMode(undefined, 'plan')).toBe('plan')
  })
})

describe('resolveClaudePermissionMode', () => {
  it('maps Agent / YOLO / Plan to Claude SDK permission modes', () => {
    expect(resolveClaudePermissionMode('agent', false)).toBe('acceptEdits')
    expect(resolveClaudePermissionMode('agent', true)).toBe('bypassPermissions')
    expect(resolveClaudePermissionMode('plan', false)).toBe('plan')
    expect(resolveClaudePermissionMode('plan', true)).toBe('plan')
  })
})

describe('resolveCodexSandboxConfig', () => {
  it('maps Agent and YOLO; collapses Plan to Agent permissions', () => {
    expect(resolveCodexSandboxConfig('agent', false)).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    expect(resolveCodexSandboxConfig('agent', true)).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    expect(resolveCodexSandboxConfig('plan', true)).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
  })
})
