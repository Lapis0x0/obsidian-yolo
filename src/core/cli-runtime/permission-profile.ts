export type CliChatMode = 'agent' | 'plan'

export type ClaudeSdkPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export type CodexApprovalPolicy =
  | 'untrusted'
  | 'on-failure'
  | 'on-request'
  | 'never'

export type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'

export type CodexSandboxConfig = {
  approvalPolicy: CodexApprovalPolicy
  sandbox: CodexSandboxMode
}

export const isCliChatMode = (value: string): value is CliChatMode =>
  value === 'agent' || value === 'plan'

export const normalizeCliChatMode = (
  raw: string | null | undefined,
  fallback: CliChatMode = 'agent',
): CliChatMode => {
  if (raw && isCliChatMode(raw)) {
    return raw
  }
  return fallback
}

/**
 * Codex has no native Plan mode in our product surface. Any stray `plan`
 * value collapses to Agent (YOLO off) permissions.
 */
export const resolveClaudePermissionMode = (
  mode: CliChatMode,
  yoloEnabled: boolean,
): ClaudeSdkPermissionMode => {
  if (mode === 'plan') {
    return 'plan'
  }
  if (yoloEnabled) {
    return 'bypassPermissions'
  }
  return 'acceptEdits'
}

export const resolveCodexSandboxConfig = (
  mode: CliChatMode,
  yoloEnabled: boolean,
): CodexSandboxConfig => {
  if (mode === 'plan') {
    return {
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    }
  }
  if (yoloEnabled) {
    return {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    }
  }
  return {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
  }
}
