import type { CliRuntime, CliSessionRef } from './types'

type NativeTitleSyncInput = {
  sessionRef: CliSessionRef
  title: string
  resolveRuntime: (runtimeId: CliSessionRef['runtimeId']) => CliRuntime
}

/**
 * Mirrors a YOLO title to a provider-native conversation without making the
 * local persistence/UI path wait for a provider RPC.
 */
export const syncNativeConversationTitle = ({
  sessionRef,
  title,
  resolveRuntime,
}: NativeTitleSyncInput): void => {
  if (sessionRef.runtimeId !== 'codex') return

  const runtime = resolveRuntime(sessionRef.runtimeId)
  if (!runtime.setSessionTitle) return

  void runtime.setSessionTitle(sessionRef, title).catch((error: unknown) => {
    console.warn('[YOLO] Failed to sync Codex conversation title', {
      threadId: sessionRef.nativeSessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}
