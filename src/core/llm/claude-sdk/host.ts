import { App, FileSystemAdapter } from 'obsidian'

import { claudeSdkSessionPool } from './sessionPool'

/**
 * Absolute vault path the Claude Agent SDK subprocess runs in.
 *
 * Module-level for the same reason `claudeSdkSessionPool` is: provider clients
 * are rebuilt on every settings change, but the subprocess and the directory
 * it runs in belong to the plugin's lifetime. Threading an `App` through
 * `getChatModelClient` instead would put it on the signature of every caller
 * — tab completion, title generation, subagents — none of which needs it.
 */
let vaultPath: string | undefined

/** Called once when the plugin loads. */
export const bindClaudeSdkHost = (app: App): void => {
  const adapter = app.vault.adapter
  vaultPath =
    adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined
}

/** Called when the plugin unloads; closes any warm subprocess. */
export const unbindClaudeSdkHost = (): void => {
  vaultPath = undefined
  claudeSdkSessionPool.disposeAll()
}

/**
 * Throws when the vault has no filesystem behind it (mobile, or a custom
 * adapter), which is the same condition that rules out CLI runtimes.
 */
export const getClaudeSdkVaultPath = (): string => {
  if (!vaultPath) {
    throw new Error('Claude requires a file-system-backed vault on desktop.')
  }
  return vaultPath
}
