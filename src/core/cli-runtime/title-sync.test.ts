import { syncNativeConversationTitle } from './title-sync'
import type { CliRuntime, CliSessionRef } from './types'

const codexSession: CliSessionRef = {
  runtimeId: 'codex',
  nativeSessionId: 'thread-1',
}

describe('syncNativeConversationTitle', () => {
  it('does not make a completed local title update wait for a pending native request', () => {
    let resolveNativeTitle!: () => void
    const setSessionTitle = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveNativeTitle = resolve
        }),
    )
    const runtime = {
      runtimeId: 'codex',
      setSessionTitle,
    } as unknown as CliRuntime
    let localTitle = 'New chat'

    localTitle = 'Renamed locally'
    syncNativeConversationTitle({
      sessionRef: codexSession,
      title: localTitle,
      resolveRuntime: () => runtime,
    })

    expect(localTitle).toBe('Renamed locally')
    expect(setSessionTitle).toHaveBeenCalledWith(codexSession, localTitle)
    resolveNativeTitle()
  })

  it('keeps a completed local title update when the native request rejects', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = {
      runtimeId: 'codex',
      setSessionTitle: jest.fn().mockRejectedValue(new Error('unsupported')),
    } as unknown as CliRuntime
    let localTitle = 'New chat'

    localTitle = 'Renamed locally'
    syncNativeConversationTitle({
      sessionRef: codexSession,
      title: localTitle,
      resolveRuntime: () => runtime,
    })

    await Promise.resolve()

    expect(localTitle).toBe('Renamed locally')
    expect(warning).toHaveBeenCalledWith(
      '[YOLO] Failed to sync Codex conversation title',
      expect.objectContaining({ threadId: 'thread-1', error: 'unsupported' }),
    )
    warning.mockRestore()
  })
})
