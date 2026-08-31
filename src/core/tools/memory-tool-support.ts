import type { PromptSourceWatcher } from '../agent/promptSourceWatcher'

// Shared by all three memory tools (`memory_add`, `memory_update`,
// `memory_delete`) alike, so it stays here rather than moving into any one
// of their directories (phase2-migration.md D6 "注意": a helper with more
// than one consumer stays in a shared location, not a single tool's
// directory). `localFileTools.ts`'s still-live memory switch cases import
// this back from here — see that file's import block.
export async function invokeMemoryTool<T extends { filePath: string }>(
  promptSourceWatcher: PromptSourceWatcher | undefined,
  fn: (hooks: { onInternalWrite?: (path: string) => void }) => Promise<T>,
): Promise<T> {
  if (!promptSourceWatcher) {
    return fn({})
  }
  let writePath: string | undefined
  try {
    return await fn({
      onInternalWrite: (path) => {
        writePath = path
        promptSourceWatcher.markInternalWriteStart(path)
      },
    })
  } finally {
    if (writePath) {
      await Promise.resolve()
      promptSourceWatcher.markInternalWriteEnd(writePath)
    }
  }
}
