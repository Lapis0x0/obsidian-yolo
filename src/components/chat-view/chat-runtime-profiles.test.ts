import { resolveChatModeRuntime } from './chat-runtime-profiles'

describe('resolveChatModeRuntime', () => {
  const assistantEnabledToolNames = [
    'yolo_local__fs_read',
    'yolo_local__fs_write',
    'yolo_local__terminal_command',
  ]

  const assistant = {
    enableTools: true,
    includeBuiltinTools: true,
    toolPreferences: {
      yolo_local__fs_write: {
        enabled: true,
        approvalMode: 'require_approval' as const,
      },
    },
  }

  it('filters write tools in ask mode and disables bypass', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'ask',
      assistant,
      assistantEnabledToolNames,
    })

    expect(runtime.allowedToolNames).toEqual(['yolo_local__fs_read'])
    expect(runtime.toolPreferences).toBeUndefined()
    expect(runtime.bypassToolApproval).toBe(false)
    expect(runtime.runtimeModePrompt).toContain('Ask mode')
    expect(runtime.runtimeModePrompt).toContain('switch to Agent mode')
  })

  it('keeps full tool set in agent mode with per-tool preferences', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'agent',
      assistant,
      assistantEnabledToolNames,
    })

    expect(runtime.allowedToolNames).toEqual(assistantEnabledToolNames)
    expect(runtime.toolPreferences).toEqual(assistant.toolPreferences)
    expect(runtime.bypassToolApproval).toBe(false)
    expect(runtime.runtimeModePrompt).toBeUndefined()
  })

  it('keeps agent tools but enables bypass in agent-full mode', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'agent-full',
      assistant,
      assistantEnabledToolNames,
    })

    expect(runtime.allowedToolNames).toEqual(assistantEnabledToolNames)
    expect(runtime.toolPreferences).toEqual(assistant.toolPreferences)
    expect(runtime.bypassToolApproval).toBe(true)
    expect(runtime.runtimeModePrompt).toBeUndefined()
  })
})
